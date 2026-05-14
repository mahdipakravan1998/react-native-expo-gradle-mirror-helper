# React Native / Expo Gradle Mirror Helper

A Node.js helper script for configuring Gradle mirrors in React Native / Expo Android projects.

This project is designed for environments where access to Gradle, Maven Central, Google Maven, or Gradle Plugin Portal may be slow, unreliable, or blocked.

It helps reduce or remove the need for a VPN during Android builds by configuring Gradle mirror repositories more completely than simply patching visible `repositories {}` blocks.

## What this script does

This helper can:

- Patch the Gradle wrapper distribution URL.
- Configure a user-level Gradle init script.
- Add configured Maven mirrors to Gradle plugin management.
- Add configured Maven mirrors to dependency resolution management.
- Add configured Maven mirrors to buildscript repositories.
- Add configured Maven mirrors to selected React Native and Expo included builds.
- Probe configured mirrors before selecting the final mirror order.
- Configure shorter Gradle HTTP timeouts to avoid long waits on unreachable repositories.

## Why this exists

In React Native / Expo Android projects, adding a Maven mirror only inside visible `repositories {}` blocks is often not enough.

Gradle may still need network access for:

- Gradle wrapper distribution downloads
- Gradle plugin resolution
- Android Gradle Plugin resolution
- Kotlin Gradle Plugin resolution
- Kotlin serialization plugin resolution
- buildscript classpath resolution
- dependency resolution management
- React Native and Expo included builds

This helper tries to cover those areas in one script.

## Important warning

This script writes a Gradle init script to the user's Gradle home directory:

```txt
~/.gradle/init.d/react-native-gradle-mirrors.init.gradle
```

On Windows, this is usually similar to:

```txt
C:\Users\<YOUR_USER>\.gradle\init.d\react-native-gradle-mirrors.init.gradle
```

This means the script can affect other Gradle projects on the same machine.

Review the generated init script before using it in sensitive, production, or company environments.

## Installation

Copy this file into your React Native / Expo project:

```txt
scripts/gradle-mirrors.cjs
```

If the `scripts` folder does not exist, create it first.

Your project should look like this:

```txt
your-react-native-project/
├─ android/
├─ node_modules/
├─ package.json
└─ scripts/
   └─ gradle-mirrors.cjs
```

## Usage

From the root of your React Native / Expo project, run:

```bash
node scripts/gradle-mirrors.cjs
```

Then run your Android build again.

For Expo projects:

```bash
npx expo run:android
```

For regular React Native / Android Gradle builds on Windows:

```bash
cd android
gradlew.bat assembleDebug
```

For macOS or Linux:

```bash
cd android
./gradlew assembleDebug
```

## Recommended package.json script

You can also add this to your `package.json`:

```json
{
  "scripts": {
    "gradle:mirrors": "node scripts/gradle-mirrors.cjs"
  }
}
```

Then run:

```bash
npm run gradle:mirrors
```

or:

```bash
yarn gradle:mirrors
```

or:

```bash
pnpm gradle:mirrors
```

## Environment variables

You can customize the script with environment variables.

| Variable | Default | Description |
|---|---|---|
| `GRADLE_MIRROR_URLS` | Built-in mirror list | Comma-separated Maven mirror URLs |
| `GRADLE_DISTRIBUTION_MIRROR_BASE` | Built-in Gradle distribution mirror | Base URL for Gradle distribution ZIP files |
| `GRADLE_MIRROR_ENABLE_OFFICIAL_REPOS` | `false` | Adds official Gradle, Google, and Maven repositories as fallback |
| `GRADLE_MIRROR_ENABLE_INCLUDED_BUILD_PROJECT_REPOS` | `true` | Injects repositories into selected React Native / Expo included builds |
| `GRADLE_MIRROR_PROBE_CLIENT` | `auto` | Probe client: `auto`, `fetch`, or `curl` |
| `GRADLE_MIRROR_PROBE_TIMEOUT_SECONDS` | `5` | Timeout per mirror probe request |
| `GRADLE_HTTP_TIMEOUT_MS` | `5000` | Gradle HTTP timeout in milliseconds |

## Example: custom mirror list

Windows PowerShell:

```powershell
$env:GRADLE_MIRROR_URLS="https://maven.myket.ir,https://archive.ito.gov.ir/gradle/maven-plugin/,https://archive.ito.gov.ir/gradle/maven-central/"
node scripts/gradle-mirrors.cjs
```

macOS / Linux:

```bash
GRADLE_MIRROR_URLS="https://maven.myket.ir,https://archive.ito.gov.ir/gradle/maven-plugin/,https://archive.ito.gov.ir/gradle/maven-central/" node scripts/gradle-mirrors.cjs
```

## Example: enable official repositories as fallback

By default, official repositories are not added by the generated init script.

If you want to keep official repositories as fallback, enable them manually.

Windows PowerShell:

```powershell
$env:GRADLE_MIRROR_ENABLE_OFFICIAL_REPOS="true"
node scripts/gradle-mirrors.cjs
```

macOS / Linux:

```bash
GRADLE_MIRROR_ENABLE_OFFICIAL_REPOS=true node scripts/gradle-mirrors.cjs
```

## How to remove the generated Gradle init script

If you want to undo the user-level Gradle init script, delete this file:

```txt
~/.gradle/init.d/react-native-gradle-mirrors.init.gradle
```

On Windows, it is usually here:

```txt
C:\Users\<YOUR_USER>\.gradle\init.d\react-native-gradle-mirrors.init.gradle
```

## Credits

Inspired by a Gradle mirror patching snippet shared in the React Native community by [Kourosh Eydivandi (@kouroshey)](https://github.com/kouroshey).

This project expands the idea into a more complete React Native / Expo Gradle mirror helper with Gradle wrapper patching, mirror probing, plugin management support, dependency resolution support, buildscript repository support, and included-build handling.

## License

MIT