import * as core from "@actions/core";

import { cleanTargetDir } from "./cleanup";
import { CacheConfig } from "./config";
import { getCacheProvider, reportError } from "./utils";

process.on("uncaughtException", (e) => {
  core.error(e.message);
  if (e.stack) {
    core.error(e.stack);
  }
});

async function run() {
  setCacheHitOutput(await run_helper());
}

async function run_helper(): Promise<CacheHit> {
  const cacheProvider = getCacheProvider();

  if (!cacheProvider.cache.isFeatureAvailable()) {
    return CacheHit.Miss;
  }

  try {
    const fullMatch = core.getInput("require-full-match").toLowerCase() === "true";
    var cacheOnFailure = core.getInput("cache-on-failure").toLowerCase();
    if (cacheOnFailure !== "true") {
      cacheOnFailure = "false";
    }
    core.exportVariable("CACHE_ON_FAILURE", cacheOnFailure);
    core.exportVariable("CARGO_INCREMENTAL", 0);

    const config = await CacheConfig.new();
    config.printInfo(cacheProvider);
    core.info("");

    core.info(`... Restoring cache ...`);
    const key = config.cacheKey;
    // Pass a copy of cachePaths to avoid mutating the original array as reported by:
    // https://github.com/actions/toolkit/pull/1378
    // TODO: remove this once the underlying bug is fixed.
    const paths = config.cachePaths.slice();

    if (fullMatch && await cacheProvider.cache.restoreCache(paths, key, [config.restoreKey], {lookupOnly: true}) !== key) {
      return CacheHit.Miss;
    }

    const restoreKey = await cacheProvider.cache.restoreCache(paths, key, [config.restoreKey]);
    if (restoreKey) {
      const match = restoreKey === key;
      core.info(`Restored from cache key "${restoreKey}" full match: ${match}.`);
      if (!match) {
        // pre-clean the target directory on cache mismatch
        for (const workspace of config.workspaces) {
          try {
            await cleanTargetDir(workspace.target, [], true);
          } catch {}
        }

        // We restored the cache but it is not a full match.
        config.saveState();
      }

      return match ? CacheHit.Full : CacheHit.Partial;
    } else {
      core.info("No cache found.");
      config.saveState();
      return CacheHit.Miss
    }
  } catch (e) {
    reportError(e);
    return CacheHit.Miss
  }
}

enum CacheHit {
  Miss,
  Partial,
  Full,
}

function setCacheHitOutput(cacheHit: CacheHit): void {
  core.setOutput("partial-hit", (cacheHit === CacheHit.Partial).toString());
  core.setOutput("cache-hit", (cacheHit === CacheHit.Full).toString());
}

run();
