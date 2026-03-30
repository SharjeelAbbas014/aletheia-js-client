import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_BINARY_NAME = osPlatform() === "win32" ? "temporal_memory.exe" : "temporal_memory";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_API_KEY = "XXX1111AAA";

export class AletheiaError extends Error {}

export class AletheiaHTTPError extends AletheiaError {
  constructor(statusCode, body, url) {
    super(`Engine request failed with HTTP ${statusCode} for ${url}: ${body}`);
    this.name = "AletheiaHTTPError";
    this.statusCode = statusCode;
    this.body = body;
    this.url = url;
  }
}

function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return null;
}

function defaultCacheDir() {
  if (osPlatform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "aletheia");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "aletheia");
}

function defaultApiKey() {
  return envFirst("ALETHEIA_API_KEY", "TEMPORAL_MEMORY_API_KEY") || DEFAULT_TEST_API_KEY;
}

function platformTag() {
  let osPart;
  if (osPlatform() === "darwin") {
    osPart = "darwin";
  } else if (osPlatform() === "linux") {
    osPart = "linux";
  } else if (osPlatform() === "win32") {
    osPart = "windows";
  } else {
    throw new AletheiaError(`Unsupported operating system: ${osPlatform()}`);
  }

  let archPart;
  if (osArch() === "x64") {
    archPart = "amd64";
  } else if (osArch() === "arm64") {
    archPart = "arm64";
  } else {
    throw new AletheiaError(`Unsupported architecture: ${osArch()}`);
  }

  return `${osPart}-${archPart}`;
}

function isRemoteSource(source) {
  return /^https?:\/\//i.test(source);
}

async function loadJsonSource(source) {
  if (isRemoteSource(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new AletheiaHTTPError(response.status, await response.text(), source);
    }
    return response.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}

async function readBytesSource(source) {
  if (isRemoteSource(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new AletheiaHTTPError(response.status, await response.text(), source);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(source);
}

function ensureExecutable(binaryPath) {
  if (osPlatform() === "win32") {
    return;
  }
  chmodSync(binaryPath, 0o755);
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function findOnPath(binaryName) {
  const pathValue = process.env.PATH || "";
  const separator = osPlatform() === "win32" ? ";" : ":";
  for (const part of pathValue.split(separator)) {
    if (!part) {
      continue;
    }
    const candidate = join(part, binaryName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toIngestPayload(item) {
  if (!item || typeof item !== "object") {
    throw new AletheiaError("Each ingest item must be an object.");
  }
  const entityId = item.entityId || item.entity_id;
  const text = item.text || item.textualContent || item.textual_content;
  if (!entityId) {
    throw new AletheiaError("ingest item is missing entityId.");
  }
  if (!text) {
    throw new AletheiaError("ingest item is missing text.");
  }
  return {
    entity_id: entityId,
    memory_id: item.memoryId || item.memory_id || `${entityId}::sdk::${randomUUID().replaceAll("-", "")}`,
    timestamp: item.timestamp || Date.now(),
    textual_content: text,
    relations: item.relations || [],
    kind: item.kind ?? null,
    enable_semantic_dedup: item.enableSemanticDedup ?? item.enable_semantic_dedup ?? null,
    enable_consolidation: item.enableConsolidation ?? item.enable_consolidation ?? null
  };
}

export class LocalEngineManager {
  constructor({
    host = "127.0.0.1",
    port = 3000,
    apiKey = null,
    binaryPath = null,
    cacheDir = null,
    dataDir = null,
    manifestUrl = null,
    version = null
  } = {}) {
    this.host = host;
    this.port = port;
    this.apiKey = apiKey || defaultApiKey();
    this.binaryPath = binaryPath;
    this.cacheDir = resolve(cacheDir || envFirst("ALETHEIA_ENGINE_CACHE_DIR", "TEMPORAL_MEMORY_ENGINE_CACHE_DIR") || defaultCacheDir());
    this.dataDir = resolve(dataDir || join(this.cacheDir, "data", `${host}-${port}`));
    this.manifestUrl = manifestUrl || envFirst("ALETHEIA_ENGINE_MANIFEST_URL", "ALETHEIA_ENGINE_MANIFEST");
    this.version = version || envFirst("ALETHEIA_ENGINE_VERSION", "TEMPORAL_MEMORY_ENGINE_VERSION");
    this.process = null;

    mkdirSync(this.cacheDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    process.on("exit", () => {
      this.stop();
    });
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async ensureEngine(version = null) {
    const requestedVersion = version || this.version;
    const explicit = this.binaryPath || envFirst("ALETHEIA_ENGINE_BINARY", "TEMPORAL_MEMORY_ENGINE_BINARY");
    if (explicit) {
      if (!existsSync(explicit)) {
        throw new AletheiaError(`Configured engine binary was not found: ${explicit}`);
      }
      ensureExecutable(explicit);
      return explicit;
    }

    const repoBinary = this.findRepoBinary();
    if (repoBinary) {
      return repoBinary;
    }

    const cachedBinary = this.cachedBinaryPath(requestedVersion);
    if (existsSync(cachedBinary)) {
      ensureExecutable(cachedBinary);
      return cachedBinary;
    }

    if (this.manifestUrl) {
      return this.downloadFromManifest(this.manifestUrl, requestedVersion);
    }

    throw new AletheiaError(
      "No engine binary found. Set ALETHEIA_ENGINE_BINARY or build target/release/temporal_memory."
    );
  }

  async start({ version = null, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
    if (this.process && this.process.exitCode === null) {
      await this.waitUntilReady(startupTimeoutMs);
      return;
    }

    try {
      await this.health();
      return;
    } catch (error) {
      if (!(error instanceof AletheiaError)) {
        throw error;
      }
    }

    const binary = await this.ensureEngine(version);
    const env = { ...process.env };
    env.TEMPORAL_MEMORY_HOST = this.host;
    env.TEMPORAL_MEMORY_PORT = String(this.port);
    env.TEMPORAL_MEMORY_DATA_DIR = this.dataDir;
    if (this.apiKey) {
      env.TEMPORAL_MEMORY_API_KEY = this.apiKey;
    }

    this.process = spawn(binary, [], {
      cwd: dirname(binary),
      env,
      stdio: "ignore"
    });

    try {
      await this.waitUntilReady(startupTimeoutMs);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (!this.process) {
      return;
    }
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
    }
    this.process = null;
  }

  async waitUntilReady(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.process && this.process.exitCode !== null) {
        throw new AletheiaError("Local engine exited before becoming healthy.");
      }
      try {
        await this.health();
        return;
      } catch (error) {
        if (!(error instanceof AletheiaError)) {
          throw error;
        }
        await sleep(250);
      }
    }
    throw new AletheiaError("Timed out waiting for the local engine to become healthy.");
  }

  async health() {
    try {
      return await this.fetchJson("/v1/health");
    } catch (error) {
      if (error instanceof AletheiaHTTPError && error.statusCode === 404) {
        return this.fetchJson("/health");
      }
      throw error;
    }
  }

  cachedBinaryPath(version = null) {
    return join(this.cacheDir, "bin", version || "current", platformTag(), ENGINE_BINARY_NAME);
  }

  findRepoBinary() {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    let cursor = currentDir;
    for (let depth = 0; depth < 8; depth += 1) {
      for (const relative of [
        join("target", "release", ENGINE_BINARY_NAME),
        join("target", "debug", ENGINE_BINARY_NAME)
      ]) {
        const candidate = join(cursor, relative);
        if (existsSync(candidate)) {
          ensureExecutable(candidate);
          return candidate;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }

    const onPath = findOnPath(ENGINE_BINARY_NAME);
    if (onPath) {
      return onPath;
    }
    return null;
  }

  async downloadFromManifest(manifestSource, version = null) {
    const manifest = await loadJsonSource(manifestSource);
    const artifacts = manifest.artifacts || manifest.binaries || {};
    const artifact = artifacts[platformTag()];
    if (!artifact) {
      throw new AletheiaError(`Manifest did not contain a binary for ${platformTag()}.`);
    }

    const outputPath = this.cachedBinaryPath(version || manifest.version || "current");
    mkdirSync(dirname(outputPath), { recursive: true });

    const binarySource = artifact.url;
    if (!binarySource) {
      throw new AletheiaError("Manifest artifact is missing a url.");
    }

    const payload = await readBytesSource(binarySource);
    if (artifact.sha256) {
      const actualSha = createHash("sha256").update(payload).digest("hex");
      if (actualSha.toLowerCase() !== String(artifact.sha256).toLowerCase()) {
        throw new AletheiaError(
          `Downloaded binary checksum mismatch: expected ${artifact.sha256}, got ${actualSha}.`
        );
      }
    }

    const tmpPath = `${outputPath}.tmp`;
    await writeFile(tmpPath, payload);
    if (osPlatform() !== "win32") {
      await chmod(tmpPath, 0o755);
    }
    await rename(tmpPath, outputPath);
    return outputPath;
  }

  async fetchJson(path) {
    const headers = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(new URL(path, `${this.baseUrl}/`), { headers });
    if (!response.ok) {
      throw new AletheiaHTTPError(response.status, await response.text(), response.url);
    }
    return response.json();
  }
}

export class AletheiaClient {
  constructor(baseUrl, { apiKey = null, timeoutMs = DEFAULT_TIMEOUT_MS, engineManager = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey || defaultApiKey();
    this.timeoutMs = timeoutMs;
    this.engineManager = engineManager;
  }

  static fromCloud(baseUrl, apiKey, options = {}) {
    return new AletheiaClient(baseUrl, { ...options, apiKey });
  }

  static async fromLocal(options = {}) {
    const manager = new LocalEngineManager(options);
    const client = new AletheiaClient(manager.baseUrl, {
      apiKey: options.apiKey || null,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      engineManager: manager
    });
    if (options.autoStart !== false) {
      await manager.start({ version: options.version });
    }
    return client;
  }

  async ensureEngine(version = null) {
    if (!this.engineManager) {
      throw new AletheiaError("ensureEngine() is available only for local clients.");
    }
    return this.engineManager.ensureEngine(version);
  }

  async startLocalEngine({ version = null, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
    if (!this.engineManager) {
      throw new AletheiaError("startLocalEngine() is available only for local clients.");
    }
    await this.engineManager.start({ version, startupTimeoutMs });
  }

  stopLocalEngine() {
    if (!this.engineManager) {
      return;
    }
    this.engineManager.stop();
  }

  async health() {
    return this.requestJson("GET", "/v1/health", { fallbackPath: "/health" });
  }

  async engineVersion() {
    return this.requestJson("GET", "/v1/version", { fallbackPath: "/version" });
  }

  async ingest({
    entityId,
    text,
    memoryId = null,
    timestamp = null,
    relations = [],
    kind = null,
    enableSemanticDedup = null,
    enableConsolidation = null
  }) {
    const payload = toIngestPayload({
      entityId,
      text,
      memoryId,
      timestamp,
      relations,
      kind,
      enableSemanticDedup,
      enableConsolidation
    });
    await this.request("POST", "/ingest", { payload });
  }

  async ingestMany(items, { batchSize = 32 } = {}) {
    if (!Array.isArray(items)) {
      throw new AletheiaError("items must be an array.");
    }
    if (batchSize <= 0) {
      throw new AletheiaError("batchSize must be greater than zero.");
    }
    for (let index = 0; index < items.length; index += batchSize) {
      const slice = items.slice(index, index + batchSize).map((item) => toIngestPayload(item));
      await this.request("POST", "/ingest/batch", { payload: { items: slice } });
    }
  }

  async query(query, { entityId = null, topK = 5, rerank = true } = {}) {
    const payload = {
      textual_query: query,
      limit: topK,
      entity_id: entityId,
      enable_neural_rerank: rerank
    };
    return this.requestJson("POST", "/query/semantic", { payload });
  }

  async requestJson(method, path, { payload = null, fallbackPath = null } = {}) {
    try {
      return await this.request(method, path, { payload });
    } catch (error) {
      if (fallbackPath && error instanceof AletheiaHTTPError && error.statusCode === 404) {
        return this.request(method, fallbackPath, { payload });
      }
      throw error;
    }
  }

  async request(method, path, { payload = null } = {}) {
    await this.ensureLocalEngine();

    const url = new URL(path, `${this.baseUrl}/`);
    const headers = { Accept: "application/json" };
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
    }
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new AletheiaHTTPError(response.status, await response.text(), response.url);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength === "0" || response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  }

  async ensureLocalEngine() {
    if (!this.engineManager) {
      return;
    }

    if (this.engineManager.process && this.engineManager.process.exitCode === null) {
      return;
    }

    try {
      await this.engineManager.health();
      return;
    } catch (error) {
      if (!(error instanceof AletheiaError)) {
        throw error;
      }
    }

    await this.engineManager.start();
  }
}

export const Client = AletheiaClient;

export function findRepoBinary() {
  const manager = new LocalEngineManager({ autoStart: false });
  return manager.findRepoBinary();
}
