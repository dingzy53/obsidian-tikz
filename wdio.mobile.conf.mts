import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import { obsidianBetaAvailable, parseObsidianVersions } from 'wdio-obsidian-service';

interface ObsidianVersionEntry {
	version: string;
	isBeta?: boolean;
	downloads?: { apk?: string };
}

function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function resolveEarliestPublicAndroid(dir: string, minAppVersion: string | undefined): string {
	if (!minAppVersion) return 'earliest';
	try {
		const raw = JSON.parse(readFileSync(path.join(dir, 'obsidian-versions.json'), 'utf8')) as {
			versions?: ObsidianVersionEntry[];
		};
		const match = raw.versions?.find(
			(entry) =>
				!entry.isBeta &&
				Boolean(entry.downloads?.apk) &&
				compareSemver(entry.version, minAppVersion) >= 0,
		);
		return match?.version ?? 'latest';
	} catch {
		return 'latest';
	}
}

function rewriteVersionSpec(spec: string, earliestApp: string, allowBeta: boolean): string {
	if (allowBeta) return spec;
	return spec
		.split(/([ ,]+)/)
		.map((token) => {
			if (!token || /^[ ,]+$/.test(token)) return token;
			const [appVer, installerVer] = token.split('/');
			if (appVer !== 'earliest') return token;
			return installerVer !== undefined ? `${earliestApp}/${installerVer}` : earliestApp;
		})
		.join('');
}

const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8')) as {
	isDesktopOnly?: boolean;
	minAppVersion?: string;
};

if (manifest.isDesktopOnly) {
	console.warn('Warning: manifest.json has isDesktopOnly: true; Android E2E tests are skipped in CI.');
}

const cacheDir = path.resolve(env.OBSIDIAN_CACHE_DIR || '.obsidian-cache');
const defaultVersions = 'earliest/earliest latest/latest';
const betaAvailable = await obsidianBetaAvailable({ cacheDir });
const earliestPublic = resolveEarliestPublicAndroid(cacheDir, manifest.minAppVersion);
const resolvedSpec = rewriteVersionSpec(
	env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? defaultVersions,
	earliestPublic,
	betaAvailable,
);
const versions = await parseObsidianVersions(resolvedSpec, { cacheDir, platform: 'android' });

if (env.CI) {
	console.log('obsidian-cache-key:', JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',

	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: 1,
	hostname: env.APPIUM_HOST || 'localhost',
	port: parseInt(env.APPIUM_PORT || '4723', 10),

	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion]) => ({
		browserName: 'obsidian',
		browserVersion: appVersion,
		platformName: 'Android',
		'appium:automationName': 'UiAutomator2',
		'appium:avd': 'obsidian_test',
		'appium:noReset': true,
		'appium:adbExecTimeout': 60 * 1000,
		'wdio:obsidianOptions': {
			plugins: ['.'],
			vault: 'test-vault',
		},
	})),

	services: [
		'obsidian',
		[
			'appium',
			{
				args: { allowInsecure: '*:chromedriver_autodownload,*:adb_shell' },
			},
		],
	],
	reporters: ['obsidian'],

	mochaOpts: {
		ui: 'bdd',
		timeout: 60 * 1000,
	},
	waitforInterval: 250,
	waitforTimeout: 10 * 1000,
	logLevel: 'warn',

	cacheDir,
	injectGlobals: false,
};
