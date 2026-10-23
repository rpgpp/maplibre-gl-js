import {spawnSync} from 'child_process';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

/** Registry that receives the private builds, unless `--registry` or `HXGIS_NPM_REGISTRY` names another one. */
const DEFAULT_REGISTRY = 'https://repo.hxgis.com/repository/npm-hosted/';

/** dist-tag the private builds go under, so `npm install maplibre-gl@hxgis` resolves to the newest one. */
const DEFAULT_TAG = 'hxgis';

/** Prerelease identifier that marks a version as this fork's, as in `6.15.0-hxgis.3`. */
const PRERELEASE_ID = 'hxgis';

/** Artifacts `npm pack` must find in `dist/`, one per step of `npm run build-dist`. */
const REQUIRED_ARTIFACTS = ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.d.ts', 'maplibre-gl.css'];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJSONPath = join(repoRoot, 'package.json');

/** `npm` ships as a shell script on Windows, which `spawnSync` can only start through a shell. */
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';

type PackageJSON = {
    name: string;
    version: string;
    publishConfig?: {
        registry?: string;
        tag?: string;
    };
};

type Options = {
    registry: string;
    tag: string;
    /** Version to publish instead of the computed `<upstream>-hxgis.<n>`. */
    version?: string;
    bumpOnly: boolean;
    skipBuild: boolean;
    dryRun: boolean;
    otp?: string;
    help: boolean;
};

/**
 * Reads the flags this script accepts, defaulting the registry and tag to the private build's own.
 *
 * An unknown flag throws rather than being ignored, so that a typo cannot silently publish to the
 * public registry or under the wrong tag.
 */
function parseArgs(argv: string[]): Options {
    const options: Options = {
        registry: process.env.HXGIS_NPM_REGISTRY ?? DEFAULT_REGISTRY,
        tag: DEFAULT_TAG,
        bumpOnly: false,
        skipBuild: false,
        dryRun: false,
        help: false,
    };

    let index = 0;
    while (index < argv.length) {
        const arg = argv[index++];
        switch (arg) {
            case '--registry':
                options.registry = argv[index++];
                break;
            case '--tag':
                options.tag = argv[index++];
                break;
            case '--version':
                options.version = argv[index++];
                break;
            case '--otp':
                options.otp = argv[index++];
                break;
            case '--bump-only':
                options.bumpOnly = true;
                break;
            case '--skip-build':
                options.skipBuild = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function readPackageJSON(): PackageJSON {
    return JSON.parse(readFileSync(packageJSONPath, 'utf8'));
}

/** Writes the manifest back in the same shape the repository keeps it: two-space indent, trailing newline. */
function writePackageJSON(pkg: PackageJSON): void {
    writeFileSync(packageJSONPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** The upstream version a private version derives from: `6.15.0-hxgis.3` → `6.15.0`. */
function upstreamVersion(version: string): string {
    return version.split('-')[0];
}

/** The counter in a private version, or `0` for a version that carries no `-hxgis.<n>` suffix. */
function prereleaseNumber(version: string): number {
    const match = new RegExp(`^\\d+\\.\\d+\\.\\d+-${PRERELEASE_ID}\\.(\\d+)$`).exec(version);
    return match ? Number(match[1]) : 0;
}

/**
 * Counters already taken by `<base>-hxgis.<n>` on the registry, or `null` when the registry cannot
 * be read — a private registry that needs a login answers `npm view` with an error.
 */
function publishedPrereleaseNumbers(name: string, registry: string, base: string): number[] | null {
    const result = spawnSync(npmCommand, ['view', name, 'versions', '--json', '--registry', registry], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: useShell,
    });
    if (result.status !== 0) return null;

    let versions: string[];
    try {
        const parsed = JSON.parse(result.stdout);
        versions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return null;
    }

    return versions.filter((version) => upstreamVersion(version) === base).map(prereleaseNumber).filter((number) => number > 0);
}

/**
 * The version to publish: the highest counter already on the registry or in the manifest, plus one.
 *
 * Counting past the registry rather than only past the manifest keeps a repeated run from packing a
 * version the registry will reject, which happens whenever the previous run published without the
 * bump being committed.
 */
function nextVersion(pkg: PackageJSON, options: Options): string {
    if (options.version) return options.version;

    const base = upstreamVersion(pkg.version);
    const published = publishedPrereleaseNumbers(pkg.name, options.registry, base);
    if (published === null) {
        console.warn(`warning: ${options.registry} did not answer \`npm view\`; numbering from package.json alone.`);
    }

    const highest = Math.max(prereleaseNumber(pkg.version), ...(published ?? []));
    return `${base}-${PRERELEASE_ID}.${highest + 1}`;
}

/** Runs a command in the repository root and fails the script if it exits non-zero. */
function run(command: string, args: string[], label: string): void {
    console.log(`\n> ${label}`);
    const result = spawnSync(command, args, {cwd: repoRoot, stdio: 'inherit', shell: useShell});
    if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function assertDistIsBuilt(): void {
    const missing = REQUIRED_ARTIFACTS.filter((file) => !existsSync(join(repoRoot, 'dist', file)));
    if (missing.length === 0) return;

    throw new Error(`dist/ is missing ${missing.join(', ')} — run \`npm run build-dist\`, or drop --skip-build.`);
}

/**
 * The `npm publish` arguments.
 *
 * `--ignore-scripts` keeps the tarball identical to the `dist/` this run built: `prepare` would
 * otherwise run `codegen` again while packing and rewrite the typings and generated sources.
 */
function publishArguments(options: Options): string[] {
    const args = ['publish', '--tag', options.tag, '--registry', options.registry, '--ignore-scripts'];
    if (options.dryRun) args.push('--dry-run');
    if (options.otp) args.push(`--otp=${options.otp}`);
    return args;
}

function printUsage(): void {
    console.log(`Usage: node build/publish-hxgis.ts [options]

  --version <x.y.z-hxgis.N>  publish this version instead of the next computed one
  --registry <url>           registry to publish to (default: ${DEFAULT_REGISTRY})
                             also settable with HXGIS_NPM_REGISTRY
  --tag <tag>                dist-tag to publish under (default: ${DEFAULT_TAG})
  --bump-only                write the next version into package.json and stop
  --skip-build               publish the existing dist/ without rebuilding it
  --dry-run                  pack and report, but do not upload
  --otp <code>               one-time password, for a registry that asks for one`);
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }

    const pkg = readPackageJSON();
    const previousVersion = pkg.version;
    const version = nextVersion(pkg, options);
    pkg.version = version;
    writePackageJSON(pkg);
    console.log(`${pkg.name}: ${previousVersion} -> ${version}`);

    if (options.bumpOnly) {
        console.log('Stopped after the bump; `npm run publish:hxgis` builds and publishes this version.');
        return;
    }

    if (options.skipBuild) assertDistIsBuilt();
    else run(npmCommand, ['run', 'build-dist'], 'building dist');

    run(npmCommand, publishArguments(options), `publishing to ${options.registry}`);

    if (options.dryRun) {
        console.log('\nDry run: nothing was uploaded.');
        return;
    }

    console.log(`\nPublished ${pkg.name}@${version} under the ${options.tag} tag.`);
    console.log(`Consumers install it with \`npm install ${pkg.name}@${version}\` or \`npm install ${pkg.name}@${options.tag}\`.`);
    console.log(`Commit the bump with \`git commit -am "chore: release ${pkg.name}@${version}"\`.`);
}

main();
