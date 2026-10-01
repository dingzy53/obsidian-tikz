export {
	compileTikz,
	sweepScratchDirs,
	DEFAULT_ENGINE,
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_IDS,
	ENGINE_SPECS,
	type CompileFailure,
	type CompileOptions,
	type CompileResult,
	type CompileSuccess,
	type EngineId,
	type EngineSpec,
} from "./engine";

export {
	describeResolution,
	detectBinaryViaLoginShell,
	knownBinDirs,
	isExecutable,
	isFlatpak,
	canFlatpakSpawnHost,
	isExecutableOnHost,
	findOnHost,
	clearHostProbeCache,
	splitPathList,
	resolveBinary,
	BinaryNotFoundError,
	type ResolveBinaryOptions,
	type ResolvedBinary,
} from "./pathResolve";

export {
	tidyTikzSource,
	normalizePreamble,
	detectTier,
	wrapTikzSource,
	PGF_DRIVER_LINE,
	STANDALONE_CLASS,
	DEFAULT_PREAMBLE,
	type SourceTier,
	type WrapOptions,
	type WrappedSource,
} from "./wrapSource";
