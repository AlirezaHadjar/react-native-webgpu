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
npm run android
```

The app has its own package identifier, `dev.webgpu.serializercollision`, and
runs independently of the upstream example app. The Android build needs Java 17
and the Android SDK. Generated native projects and device logs are ignored.

## Cases

Open a URL in a fresh app process:

```sh
adb shell am force-stop dev.webgpu.serializercollision
adb shell am start -W -a android.intent.action.VIEW -d 'serializer-repro://run?order=webgpu-first&test=transfer&kind=rect' dev.webgpu.serializercollision
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

Stock behavior: WebGPU-first transfers of a Skia rectangle or paint crash during
unboxing; Skia-first transfers succeed. Direct WebGPU boxing of a Skia rectangle
succeeds but its unbox throws the missing-class error, in either order.

With the proposed fix, WebGPU's serializer only claims objects whose prototype
carries WebGPU's `__webgpuBox` method, so it no longer claims Skia objects and
every transfer and round trip succeeds in either order. The direct test then
reports `webgpuAccepts: false`; calling the global `__webgpuBox` by hand still
produces an unboxable wrapper. Plain objects, custom-prototype objects, and
genuine GPU buffers transfer in both builds.

## Repeat and preserve evidence

```sh
python3 run-android.py --serial DEVICE_SERIAL --repetitions 5 --expect baseline   # stock WebGPU
python3 run-android.py --serial DEVICE_SERIAL --repetitions 5 --expect fixed      # with the fix
```

The phone must be unlocked with the screen on: behind a secure keyguard,
`navigator.gpu.requestAdapter()` does not resolve and the buffer cases time out.
`--kinds buffer` reruns a subset.

The runner cold-starts each case, records logs without clearing the device's
log buffers, and only reads lines from the PID that logged the case's `start`
event. A crash is an `AndroidRuntime` fatal exception for that PID; the
missing-class brand and whether the process exited within five seconds are
recorded separately. Outcomes and a summary are written to `--output`.
