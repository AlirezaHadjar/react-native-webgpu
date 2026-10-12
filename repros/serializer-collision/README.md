# Skia / WebGPU serializer collision reproduction

This app tests native object transfer without confetti, navigation, shader
compilation, or a render loop. Each trial starts a fresh process so the serializer
registration order comes only from the selected imports.

The app uses the WebGPU source from this checkout, Skia 3.4.0, React Native
0.86.3, Worklets 0.13.0, and Expo 57. The test does not modify either serializer's
acceptance predicate. Diagnostic wrappers log which packer is selected.

## Setup

Install the monorepo dependencies and build the WebGPU Expo config plugin first:

```sh
yarn install
yarn workspace react-native-webgpu build:plugin
cd repros/serializer-collision
npm install --install-links --workspaces=false --legacy-peer-deps
npm run android   # or: npm run ios
```

The app has its own package identifier, `dev.webgpu.serializercollision`, and
runs independently of the upstream example app. The Android build needs Java 17
and the Android SDK; the iOS build needs Xcode and CocoaPods. Generated native
projects and device logs are ignored.

## Cases

Open a URL in a fresh app process:

```sh
adb shell am force-stop dev.webgpu.serializercollision
adb shell am start -W -a android.intent.action.VIEW -d 'serializer-repro://run?order=webgpu-first&test=transfer&kind=rect' dev.webgpu.serializercollision
```

On an iOS simulator, launch the app before opening the URL; otherwise iOS asks
"Open in ...?" first:

```sh
xcrun simctl terminate booted dev.webgpu.serializercollision
xcrun simctl launch booted dev.webgpu.serializercollision
xcrun simctl openurl booted 'serializer-repro://run?order=webgpu-first&test=transfer&kind=rect'
```

- `order`: `webgpu-first` or `skia-first`.
- `test=transfer`: sends the object to a UI worklet using `scheduleOnUI`.
- `test=roundtrip`: sends the object to a UI worklet, which sends it back with
  `scheduleOnRN`. This runs the serializers' `determine` on the UI runtime.
- `test=direct`: explicitly boxes a Skia rectangle using each library's box
  function. A caught WebGPU unbox failure plus a successful Skia unbox
  distinguish the two native decoders that use the same error wording.
- `kind`: `rect`, `paint`, `plain`, `buffer`, or `proto`. The GPU buffer control
  uses a real adapter/device and has no rendering or GPU error listener.
  `proto` (round trip only) is created on the UI runtime with a custom
  prototype, so it reaches the custom serializer loop there.

Stock behavior: WebGPU-first transfers and round trips of a Skia rectangle or
paint crash during unboxing; Skia-first transfers succeed. Android reports a
fatal `RuntimeException`, iOS aborts on an uncaught `std::runtime_error`, both
with the same `Failed to deserialize CustomSerializable` message. Direct WebGPU
boxing of a Skia rectangle succeeds but its unbox throws the missing-class
error, in either order.

With the proposed fix, WebGPU's serializer only claims objects whose prototype
carries WebGPU's `__webgpuBox` method, so it no longer claims Skia objects and
every transfer and round trip succeeds in either order. The direct test then
reports `webgpuAccepts: false`; calling the global `__webgpuBox` by hand still
produces an unboxable wrapper. Plain objects, custom-prototype objects, and
genuine GPU buffers transfer in both builds.

## Repeat and preserve evidence

```sh
node run-trials.mjs --serial DEVICE_SERIAL --expect baseline     # Android, stock WebGPU
node run-trials.mjs --simulator SIMULATOR_UDID --expect fixed    # iOS simulator, with the fix
```

Each case runs five times by default (`--repetitions`); `--kinds buffer,rect`
and `--tests roundtrip` select a subset. An Android phone must be unlocked with
the screen on: behind a secure keyguard, `navigator.gpu.requestAdapter()` does
not resolve and the buffer cases time out.

The runner cold-starts each case and only reads log lines from the process that
logged the case's `start` event. On Android a crash is an `AndroidRuntime` fatal
exception for that process; on iOS it is that process exiting, with the brand
read from the app's stderr. The missing-class brand and whether the process
exited within five seconds are recorded separately. Outcomes and a summary are
written to `--output`.
