/**
 * Tests run in plain Node, so they hand the desktop modules (`cache.ts`,
 * `compiler/*`) the real Node.js modules, as `loadNodeApi()` in `desktop.ts`
 * does inside Obsidian.
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as timers from "node:timers";
import { provideNodeApi } from "../../src/nodeApi";

provideNodeApi({ childProcess, crypto, fs, fsp, os, path, timers });
