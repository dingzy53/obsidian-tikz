import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import { parseObsidianVersions } from 'wdio-obsidian-service';

const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8')) as {
	isDesktopOnly?: boolean;
};

if (manifest.isDesktopOnly) {
	console.warn('Warning: manifest.json has isDesktopOnly: true; Android E2E tests are skipped in CI.');
}

const cacheDir = path.resolve(env.OBSIDIAN_CACHE_DIR || '.obsidian-cache');
const defaultVersions = 'earliest/earliest latest/latest';
const versions = await parseObsidianVersions(
	env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? defaultVersions,
	{ cacheDir },
);

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
