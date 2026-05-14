const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = process.cwd();
const androidDir = path.join(projectRoot, 'android');
const nodeModulesDir = path.join(projectRoot, 'node_modules');

const gradleWrapperFile = path.join(
  androidDir,
  'gradle',
  'wrapper',
  'gradle-wrapper.properties',
);

const gradlePropertiesFile = path.join(androidDir, 'gradle.properties');

const defaultMirrorUrls = [
  'https://maven.myket.ir',
  'https://archive.ito.gov.ir/gradle/maven-plugin/',
  'https://archive.ito.gov.ir/gradle/maven-central/',
];

const defaultGradleDistributionMirrorBase =
  'https://maven.myket.ir/gradle/distributions';

const fallbackVersions = {
  kotlinGradlePlugin: '2.1.20',
  androidGradlePlugin: '8.5.0',
  kotlinSerializationPlugin: '1.9.24',
};

// Official repositories stay opt-in so mirror-only builds remain deterministic.
const officialReposEnabled = readBooleanEnv(
  'GRADLE_MIRROR_ENABLE_OFFICIAL_REPOS',
  false,
);

// Included builds need targeted repository injection because Gradle treats them as isolated builds.
const includedBuildProjectReposEnabled = readBooleanEnv(
  'GRADLE_MIRROR_ENABLE_INCLUDED_BUILD_PROJECT_REPOS',
  true,
);

// Allow the probe transport to be forced when fetch or curl behaves better in the local environment.
const probeClient = readEnumEnv(
  'GRADLE_MIRROR_PROBE_CLIENT',
  ['auto', 'fetch', 'curl'],
  'auto',
);

// Keep mirror probes short so unavailable repositories do not stall setup.
const probeTimeoutSeconds = readPositiveIntegerEnv(
  'GRADLE_MIRROR_PROBE_TIMEOUT_SECONDS',
  5,
);

const gradleHttpTimeoutMs = String(
  readPositiveIntegerEnv('GRADLE_HTTP_TIMEOUT_MS', 5000),
);

const mirrorUrls = parseMirrorUrls(
  process.env.GRADLE_MIRROR_URLS,
  defaultMirrorUrls,
);

const gradleDistributionMirrorBase = normalizeBaseUrl(
  process.env.GRADLE_DISTRIBUTION_MIRROR_BASE?.trim() ||
    defaultGradleDistributionMirrorBase,
);

const gradleUserHome = process.env.GRADLE_USER_HOME
  ? path.resolve(process.env.GRADLE_USER_HOME)
  : path.join(os.homedir(), '.gradle');

const gradleInitDir = path.join(gradleUserHome, 'init.d');

const gradleInitFile = path.join(
  gradleInitDir,
  'react-native-gradle-mirrors.init.gradle',
);

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue.trim() === '') {
    return defaultValue;
  }

  const value = rawValue.trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;

  console.warn(
    `Warning: ignoring invalid boolean value for ${name}: ${rawValue}. ` +
      `Using ${defaultValue}.`,
  );

  return defaultValue;
}

function readEnumEnv(name, allowedValues, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue.trim() === '') {
    return defaultValue;
  }

  const value = rawValue.trim().toLowerCase();

  if (allowedValues.includes(value)) {
    return value;
  }

  console.warn(
    `Warning: ignoring invalid value for ${name}: ${rawValue}. ` +
      `Allowed values: ${allowedValues.join(', ')}. Using ${defaultValue}.`,
  );

  return defaultValue;
}

function readPositiveIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue.trim() === '') {
    return defaultValue;
  }

  const value = Number(rawValue.trim());

  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  console.warn(
    `Warning: ignoring invalid positive integer for ${name}: ${rawValue}. ` +
      `Using ${defaultValue}.`,
  );

  return defaultValue;
}

function parseMirrorUrls(rawValue, fallbackUrls) {
  if (rawValue == null) {
    return fallbackUrls.map(normalizeBaseUrl);
  }

  const urls = rawValue
    .split(',')
    .map((url) => normalizeBaseUrl(url.trim()))
    .filter(Boolean)
    .filter((url, index, array) => array.indexOf(url) === index);

  if (urls.length === 0) {
    console.warn(
      'Warning: GRADLE_MIRROR_URLS was provided but no usable mirror URL was found.',
    );
    console.warn('Using the built-in default mirror list instead.');
    return fallbackUrls.map(normalizeBaseUrl);
  }

  return urls;
}

function getStats(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }

    throw error;
  }
}

function fileExists(filePath) {
  const stats = getStats(filePath);
  return Boolean(stats?.isFile());
}

function directoryExists(dirPath) {
  const stats = getStats(dirPath);
  return Boolean(stats?.isDirectory());
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readText(filePath) {
  if (!fileExists(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function writeTextAtomic(filePath, content) {
  ensureDirectory(path.dirname(filePath));

  const tempFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fileExists(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Preserve the original write failure if temporary-file cleanup also fails.
    }

    throw error;
  }
}

function formatPathForLog(filePath) {
  const relative = path.relative(projectRoot, filePath);

  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }

  return filePath;
}

function writeTextIfChanged(filePath, before, after) {
  if (before === after) return false;

  writeTextAtomic(filePath, after);
  console.log(`Patched: ${formatPathForLog(filePath)}`);
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertGradleProperty(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  return `${content.trimEnd()}\n${line}\n`;
}

function appendJvmArg(content, arg) {
  const pattern = /^org\.gradle\.jvmargs=(.*)$/m;
  const match = content.match(pattern);

  if (match) {
    const currentArgs = match[1].trim().split(/\s+/).filter(Boolean);

    if (currentArgs.includes(arg)) {
      return content;
    }

    return content.replace(pattern, (line) => `${line.trimEnd()} ${arg}`);
  }

  return `${content.trimEnd()}\norg.gradle.jvmargs=${arg}\n`;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

function createArtifactUrl(baseUrl, artifactPath) {
  return `${normalizeBaseUrl(baseUrl)}${artifactPath}`;
}

function escapeGradlePropertyUrl(url) {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*):/, '$1\\:');
}

function groovySingleQuotedString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function findFirstMatchInFiles(filePaths, patterns) {
  for (const filePath of filePaths) {
    const text = readText(filePath);
    if (text == null) continue;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1];
    }
  }

  return null;
}

function detectVersion(label, filePaths, patterns, fallbackVersion) {
  const detectedVersion = findFirstMatchInFiles(filePaths, patterns);

  if (detectedVersion) {
    console.log(`Detected ${label}: ${detectedVersion}`);
    return detectedVersion;
  }

  console.warn(`Warning: could not detect ${label}. Using fallback ${fallbackVersion}.`);
  return fallbackVersion;
}

function detectKotlinGradlePluginVersion() {
  return detectVersion(
    'Kotlin Gradle Plugin',
    [
      path.join(nodeModulesDir, '@react-native', 'gradle-plugin', 'build.gradle.kts'),
      path.join(nodeModulesDir, '@react-native', 'gradle-plugin', 'settings.gradle.kts'),
      path.join(androidDir, 'build.gradle'),
      path.join(androidDir, 'build.gradle.kts'),
      path.join(androidDir, 'gradle', 'libs.versions.toml'),
      path.join(projectRoot, 'gradle', 'libs.versions.toml'),
    ],
    [
      /id\("org\.jetbrains\.kotlin\.jvm"\)\s*version\s*["']([^"']+)["']/,
      /id\("org\.jetbrains\.kotlin\.android"\)\s*version\s*["']([^"']+)["']/,
      /id\("org\.jetbrains\.kotlin\.jvm"\)\.version\(["']([^"']+)["']\)/,
      /id\("org\.jetbrains\.kotlin\.android"\)\.version\(["']([^"']+)["']\)/,
      /kotlinVersion\s*=\s*["']([^"']+)["']/,
      /kotlin\s*=\s*["']([^"']+)["']/,
      /kotlin-gradle-plugin\s*=\s*["']([^"']+)["']/,
    ],
    fallbackVersions.kotlinGradlePlugin,
  );
}

function detectAndroidGradlePluginVersion() {
  return detectVersion(
    'Android Gradle Plugin',
    [
      path.join(androidDir, 'build.gradle'),
      path.join(androidDir, 'build.gradle.kts'),
      path.join(androidDir, 'gradle', 'libs.versions.toml'),
      path.join(projectRoot, 'gradle', 'libs.versions.toml'),
      path.join(nodeModulesDir, '@react-native', 'gradle-plugin', 'build.gradle.kts'),
      path.join(
        nodeModulesDir,
        'expo-modules-core',
        'expo-module-gradle-plugin',
        'build.gradle.kts',
      ),
    ],
    [
      /id\("com\.android\.application"\)\s*version\s*["']([^"']+)["']/,
      /id\("com\.android\.library"\)\s*version\s*["']([^"']+)["']/,
      /id\("com\.android\.application"\)\.version\(["']([^"']+)["']\)/,
      /id\("com\.android\.library"\)\.version\(["']([^"']+)["']\)/,
      /com\.android\.tools\.build:gradle:([^"')\s]+)/,
      /androidGradlePluginVersion\s*=\s*["']([^"']+)["']/,
      /androidGradlePlugin\s*=\s*["']([^"']+)["']/,
      /agp\s*=\s*["']([^"']+)["']/,
    ],
    fallbackVersions.androidGradlePlugin,
  );
}

function detectKotlinSerializationPluginVersion() {
  return detectVersion(
    'Kotlin Serialization Plugin',
    [
      path.join(
        nodeModulesDir,
        'expo-modules-autolinking',
        'android',
        'expo-gradle-plugin',
        'expo-autolinking-plugin-shared',
        'build.gradle.kts',
      ),
      path.join(
        nodeModulesDir,
        'expo-modules-autolinking',
        'android',
        'expo-gradle-plugin',
        'expo-autolinking-plugin',
        'build.gradle.kts',
      ),
      path.join(androidDir, 'build.gradle'),
      path.join(androidDir, 'build.gradle.kts'),
    ],
    [
      /id\("org\.jetbrains\.kotlin\.plugin\.serialization"\)\s*version\s*["']([^"']+)["']/,
      /id\("org\.jetbrains\.kotlin\.plugin\.serialization"\)\.version\(["']([^"']+)["']\)/,
    ],
    fallbackVersions.kotlinSerializationPlugin,
  );
}

function createProbeArtifacts() {
  const kotlinVersion = detectKotlinGradlePluginVersion();
  const agpVersion = detectAndroidGradlePluginVersion();
  const serializationVersion = detectKotlinSerializationPluginVersion();

  return [
    {
      name: 'Kotlin Gradle Plugin',
      path: `/org/jetbrains/kotlin/kotlin-gradle-plugin/${kotlinVersion}/kotlin-gradle-plugin-${kotlinVersion}.pom`,
      weight: 6,
      critical: true,
    },
    {
      name: 'Kotlin Serialization Plugin',
      path: `/org/jetbrains/kotlin/kotlin-serialization/${serializationVersion}/kotlin-serialization-${serializationVersion}.pom`,
      weight: 4,
      critical: false,
    },
    {
      name: 'Kotlin Serialization Plugin Marker',
      path: `/org/jetbrains/kotlin/plugin/serialization/org.jetbrains.kotlin.plugin.serialization.gradle.plugin/${serializationVersion}/org.jetbrains.kotlin.plugin.serialization.gradle.plugin-${serializationVersion}.pom`,
      weight: 1,
      critical: false,
    },
    {
      name: 'Android Gradle Plugin',
      path: `/com/android/tools/build/gradle/${agpVersion}/gradle-${agpVersion}.pom`,
      weight: 6,
      critical: true,
    },
    {
      name: 'AndroidX Collection',
      path: '/androidx/collection/collection/1.0.0/collection-1.0.0.pom',
      weight: 2,
      critical: false,
    },
    {
      name: 'AndroidX CoordinatorLayout',
      path: '/androidx/coordinatorlayout/coordinatorlayout/1.1.0/coordinatorlayout-1.1.0.pom',
      weight: 2,
      critical: false,
    },
    {
      name: 'Gson',
      path: '/com/google/code/gson/gson/2.8.9/gson-2.8.9.pom',
      weight: 1,
      critical: false,
    },
    {
      name: 'Guava',
      path: '/com/google/guava/guava/31.0.1-jre/guava-31.0.1-jre.pom',
      weight: 1,
      critical: false,
    },
  ];
}

async function runFetchProbe(url, method) {
  const startedAt = Date.now();

  if (typeof fetch !== 'function') {
    return {
      ok: false,
      statusCode: null,
      elapsedMs: 0,
      stderr: 'native fetch is not available in this Node.js runtime',
      exitCode: null,
      method,
      client: 'fetch',
      transportError: true,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    probeTimeoutSeconds * 1000,
  );

  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    return {
      ok: response.status >= 200 && response.status < 400,
      statusCode: response.status,
      elapsedMs: Date.now() - startedAt,
      stderr: '',
      exitCode: 0,
      method,
      client: 'fetch',
      transportError: false,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      elapsedMs: Date.now() - startedAt,
      stderr: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error),
      exitCode: null,
      method,
      client: 'fetch',
      transportError: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function runCurlProbe(url, method) {
  const outputTarget = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const curlBinary = process.platform === 'win32' ? 'curl.exe' : 'curl';

  const args = [
    '--location',
    '--silent',
    '--show-error',
    '--output',
    outputTarget,
    '--write-out',
    '\n%{http_code} %{time_total}',
    '--connect-timeout',
    String(probeTimeoutSeconds),
    '--max-time',
    String(probeTimeoutSeconds),
  ];

  if (process.platform === 'win32') {
    args.push('--ssl-no-revoke');
  }

  if (method === 'HEAD') {
    args.push('--head');
  }

  args.push(url);

  const startedAt = Date.now();

  const result = spawnSync(curlBinary, args, {
    encoding: 'utf8',
    timeout: (probeTimeoutSeconds + 2) * 1000,
    windowsHide: true,
  });

  const fallbackElapsedMs = Date.now() - startedAt;
  const stdout = (result.stdout || '').trim();
  const stderrParts = [];

  if (result.stderr) stderrParts.push(result.stderr.trim());
  if (result.error) stderrParts.push(result.error.message);
  if (result.signal) stderrParts.push(`terminated by signal ${result.signal}`);

  const matches = [...stdout.matchAll(/(\d{3})\s+([\d.]+)/g)];
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : null;
  const statusCode = lastMatch ? Number(lastMatch[1]) : null;
  const curlTimeSeconds = lastMatch ? Number(lastMatch[2]) : null;

  const elapsedMs =
    typeof curlTimeSeconds === 'number' && !Number.isNaN(curlTimeSeconds)
      ? Math.round(curlTimeSeconds * 1000)
      : fallbackElapsedMs;

  return {
    ok: statusCode !== null && statusCode >= 200 && statusCode < 400,
    statusCode,
    elapsedMs,
    stderr: stderrParts.filter(Boolean).join('; '),
    exitCode: result.status,
    method,
    client: 'curl',
    transportError: statusCode == null,
  };
}

async function runHttpProbe(url, method) {
  if (probeClient === 'fetch') {
    return runFetchProbe(url, method);
  }

  if (probeClient === 'curl') {
    return runCurlProbe(url, method);
  }

  const fetchResult = await runFetchProbe(url, method);

  if (fetchResult.ok || !fetchResult.transportError) {
    return fetchResult;
  }

  const curlResult = runCurlProbe(url, method);

  if (!curlResult.ok && fetchResult.stderr) {
    return {
      ...curlResult,
      stderr: [
        `fetch: ${fetchResult.stderr}`,
        curlResult.stderr ? `curl: ${curlResult.stderr}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    };
  }

  return curlResult;
}

async function probeArtifact(baseUrl, artifact) {
  const url = createArtifactUrl(baseUrl, artifact.path);

  const headResult = await runHttpProbe(url, 'HEAD');

  if (headResult.ok) {
    return {
      ...headResult,
      artifact,
      url,
    };
  }

  const getResult = await runHttpProbe(url, 'GET');

  return {
    ...getResult,
    artifact,
    url,
  };
}

async function probeMirror(baseUrl, artifacts) {
  const results = [];

  for (const artifact of artifacts) {
    const result = await probeArtifact(baseUrl, artifact);
    results.push(result);
  }

  const availableResults = results.filter((result) => result.ok);

  const score = availableResults.reduce(
    (sum, result) => sum + result.artifact.weight,
    0,
  );

  const criticalArtifactCount = artifacts.filter(
    (artifact) => artifact.critical,
  ).length;

  const availableCriticalArtifactCount = results.filter(
    (result) => result.ok && result.artifact.critical,
  ).length;

  const hasAllCriticalArtifacts =
    availableCriticalArtifactCount === criticalArtifactCount;

  const averageElapsedMs =
    results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length;

  return {
    baseUrl,
    score,
    averageElapsedMs,
    hasAllCriticalArtifacts,
    results,
  };
}

function formatArtifactResult(result) {
  const status = result.statusCode ? `HTTP ${result.statusCode}` : 'no HTTP';
  const error = result.stderr ? `, ${result.stderr}` : '';
  return `${result.artifact.name}: ${result.client}/${result.method}, ${status}, ${result.elapsedMs}ms${error}`;
}

async function selectMirrors() {
  const artifacts = createProbeArtifacts();

  console.log('Probing Gradle mirrors...');
  console.log(`Probe timeout per request: ${probeTimeoutSeconds}s`);
  console.log(`Probe client: ${probeClient}`);

  const probeResults = [];

  for (const url of mirrorUrls) {
    console.log(`Checking: ${url}`);

    const result = await probeMirror(url, artifacts);
    probeResults.push(result);

    const available = result.results
      .filter((item) => item.ok)
      .map((item) => item.artifact.name)
      .join(', ');

    console.log(
      `  score=${result.score}, avg=${Math.round(
        result.averageElapsedMs,
      )}ms, allCritical=${
        result.hasAllCriticalArtifacts ? 'yes' : 'no'
      }, available=${available || 'none'}`,
    );

    for (const artifactResult of result.results) {
      if (artifactResult.ok || artifactResult.artifact.critical) {
        console.log(`    ${formatArtifactResult(artifactResult)}`);
      }
    }
  }

  const usefulMirrors = probeResults
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.hasAllCriticalArtifacts !== a.hasAllCriticalArtifacts) {
        return (
          Number(b.hasAllCriticalArtifacts) -
          Number(a.hasAllCriticalArtifacts)
        );
      }

      if (b.score !== a.score) return b.score - a.score;

      return a.averageElapsedMs - b.averageElapsedMs;
    });

  const selected = usefulMirrors
    .map((result) => result.baseUrl)
    .filter((url, index, array) => array.indexOf(url) === index);

  if (selected.length === 0) {
    console.warn('Warning: mirror probe could not confirm any useful mirror.');
    console.warn(
      'Keeping the configured mirror order instead of writing an empty mirror list.',
    );

    return mirrorUrls;
  }

  if (!usefulMirrors.some((result) => result.hasAllCriticalArtifacts)) {
    console.warn(
      'Warning: no probed mirror contained all critical Gradle plugin artifacts.',
    );
    console.warn(
      'The generated init script may still fail unless another configured repository supplies them.',
    );
  }

  return selected;
}

function patchGradleWrapper() {
  const before = readText(gradleWrapperFile);

  if (before == null) {
    console.warn(
      'Skipped: android/gradle/wrapper/gradle-wrapper.properties not found',
    );
    return false;
  }

  const match = before.match(/^distributionUrl=(.+)$/m);

  if (!match) {
    console.warn(
      'Skipped: distributionUrl not found in gradle-wrapper.properties',
    );
    return false;
  }

  const currentUrl = match[1].trim().replace(/\\:/g, ':');
  const fileNameMatch = currentUrl.match(/(gradle-[^/\\]+-(bin|all)\.zip)(?:[?#].*)?$/);

  if (!fileNameMatch) {
    console.warn(
      `Skipped: could not detect Gradle distribution file name from ${currentUrl}`,
    );
    return false;
  }

  const distributionFileName = fileNameMatch[1];
  const mirroredUrl = `${gradleDistributionMirrorBase}/${distributionFileName}`;
  const escapedUrl = escapeGradlePropertyUrl(mirroredUrl);

  const after = before.replace(
    /^distributionUrl=.+$/m,
    `distributionUrl=${escapedUrl}`,
  );

  return writeTextIfChanged(gradleWrapperFile, before, after);
}

function patchGradleProperties() {
  const before = readText(gradlePropertiesFile);

  if (before == null) {
    console.warn('Skipped: android/gradle.properties not found');
    return false;
  }

  let after = before;

  after = appendJvmArg(after, '-Djava.net.preferIPv4Stack=true');

  after = upsertGradleProperty(
    after,
    'systemProp.org.gradle.internal.http.connectionTimeout',
    gradleHttpTimeoutMs,
  );

  after = upsertGradleProperty(
    after,
    'systemProp.org.gradle.internal.http.socketTimeout',
    gradleHttpTimeoutMs,
  );

  after = upsertGradleProperty(
    after,
    'systemProp.org.gradle.internal.repository.max.retries',
    '1',
  );

  after = upsertGradleProperty(
    after,
    'systemProp.org.gradle.internal.repository.initial.backoff',
    '250',
  );

  return writeTextIfChanged(gradlePropertiesFile, before, after);
}

function createGradleInitScript(selectedMirrorUrls) {
  const mirrorList = selectedMirrorUrls
    .map((url) => `    ${groovySingleQuotedString(url)}`)
    .join(',\n');

  const officialPluginReposBlock = officialReposEnabled
    ? `
      gradlePluginPortal()
      google()
      mavenCentral()`
    : '';

  const officialBuildscriptReposBlock = officialReposEnabled
    ? `
      google()
      mavenCentral()
      gradlePluginPortal()`
    : '';

  const officialDependencyReposBlock = officialReposEnabled
    ? `
      google()
      mavenCentral()`
    : '';

  const officialIncludedBuildReposBlock = officialReposEnabled
    ? `
      google()
      mavenCentral()
      gradlePluginPortal()`
    : '';

  return `
// Generated by the React Native / Expo Gradle mirror helper.
// Keeps configured mirrors centralized while preserving project repositories.
// Official repositories added by this init script: ${officialReposEnabled ? 'yes' : 'no'}
// Included-build repository injection enabled: ${includedBuildProjectReposEnabled ? 'yes' : 'no'}

def mirrorUrls = [
${mirrorList}
]

def kotlinGradlePluginIds = [
  'org.jetbrains.kotlin.jvm',
  'org.jetbrains.kotlin.android',
  'org.jetbrains.kotlin.kapt',
  'kotlin-android',
  'kotlin-kapt'
] as Set

def androidGradlePluginIds = [
  'com.android.application',
  'com.android.library',
  'com.android.test',
  'com.android.dynamic-feature'
] as Set

def kotlinSerializationPluginIds = [
  'org.jetbrains.kotlin.plugin.serialization'
] as Set

def includedBuildProjectReposEnabled = ${includedBuildProjectReposEnabled ? 'true' : 'false'}

def normalizePath = { value ->
  value == null ? '' : value.toString().replace('\\\\', '/')
}

def isReactNativeOrExpoIncludedBuild = { project ->
  def rootPath = normalizePath(project.rootProject.rootDir.absolutePath)

  return rootPath.contains('/node_modules/@react-native/gradle-plugin') ||
    rootPath.contains('/node_modules/expo-modules-autolinking/android/expo-gradle-plugin') ||
    rootPath.contains('/node_modules/expo-modules-core/expo-module-gradle-plugin')
}

def addConfiguredMirrors = { repositories ->
  mirrorUrls.eachWithIndex { repoUrl, index ->
    repositories.maven {
      name = "ConfiguredMirror" + (index + 1)
      url = uri(repoUrl)
    }
  }
}

beforeSettings { settings ->
  settings.pluginManagement {
    repositories {
      addConfiguredMirrors(delegate)${officialPluginReposBlock}
    }

    resolutionStrategy {
      eachPlugin {
        if (requested.version != null && kotlinGradlePluginIds.contains(requested.id.id)) {
          useModule("org.jetbrains.kotlin:kotlin-gradle-plugin:\${requested.version}")
        }

        if (requested.version != null && androidGradlePluginIds.contains(requested.id.id)) {
          useModule("com.android.tools.build:gradle:\${requested.version}")
        }

        if (requested.version != null && kotlinSerializationPluginIds.contains(requested.id.id)) {
          useModule("org.jetbrains.kotlin:kotlin-serialization:\${requested.version}")
        }
      }
    }
  }
}

settingsEvaluated { settings ->
  settings.dependencyResolutionManagement {
    repositories {
      addConfiguredMirrors(delegate)${officialDependencyReposBlock}
    }
  }
}

allprojects { project ->
  buildscript {
    repositories {
      addConfiguredMirrors(delegate)${officialBuildscriptReposBlock}
    }
  }

  if (includedBuildProjectReposEnabled && isReactNativeOrExpoIncludedBuild(project)) {
    repositories {
      addConfiguredMirrors(delegate)${officialIncludedBuildReposBlock}
    }
  }
}
`.trimStart();
}

function writeGradleInitScript(selectedMirrorUrls) {
  const before = readText(gradleInitFile) || '';
  const after = createGradleInitScript(selectedMirrorUrls);

  return writeTextIfChanged(gradleInitFile, before, after);
}

function exitWithError(message, detail) {
  console.error(message);
  if (detail) console.error(detail);
  process.exit(1);
}

async function main() {
  console.log('Configuring Gradle mirrors...');
  console.log(`Probe timeout: ${probeTimeoutSeconds}s`);
  console.log(`Probe client: ${probeClient}`);
  console.log(`Gradle HTTP timeout: ${gradleHttpTimeoutMs}ms`);
  console.log(
    `Official Gradle repositories added by init script: ${
      officialReposEnabled ? 'yes' : 'no'
    }`,
  );
  console.log(
    `Included-build project repository injection: ${
      includedBuildProjectReposEnabled ? 'enabled' : 'disabled'
    }`,
  );
  console.log('Project/local repositories: preserved');

  if (!directoryExists(androidDir)) {
    exitWithError(
      'Error: android/ folder not found.',
      'Run Android prebuild/generation first, then rerun this script.',
    );
  }

  if (!directoryExists(nodeModulesDir)) {
    exitWithError(
      'Error: node_modules/ folder not found.',
      'Run your package manager install command first, then rerun this script.',
    );
  }

  const selectedMirrorUrls = await selectMirrors();

  console.log('Selected mirror order:');
  for (const url of selectedMirrorUrls) {
    console.log(`- ${url}`);
  }

  let changedCount = 0;

  if (patchGradleWrapper()) changedCount += 1;
  if (patchGradleProperties()) changedCount += 1;
  if (writeGradleInitScript(selectedMirrorUrls)) changedCount += 1;

  console.log(`Done. Files changed: ${changedCount}`);
  console.log(`Gradle init script: ${gradleInitFile}`);
}

main().catch((error) => {
  console.error('Fatal error while configuring Gradle mirrors.');
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
