import React, { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";

const TAG = "SERIALIZER_REPRO";
let started = false;

const message = (event, details) => {
  console.log(`${TAG} ${JSON.stringify({ event, ...details })}`);
};

const describeRect = (value) => ({
  x: value.x,
  y: value.y,
  width: value.width,
  height: value.height,
});

const loadLibraries = (order) => {
  let skia;
  if (order === "webgpu-first") {
    require("react-native-webgpu");
    message("import", { library: "WebGPU" });
    skia = require("react-native-skia");
    message("import", { library: "Skia" });
  } else if (order === "skia-first") {
    skia = require("react-native-skia");
    message("import", { library: "Skia" });
    require("react-native-webgpu");
    message("import", { library: "WebGPU" });
  } else {
    throw new Error(`Unknown order: ${order}`);
  }
  return skia.Skia;
};

async function run(url, complete) {
  if (started) return;
  started = true;
  const query = new URL(url).searchParams;
  const order = query.get("order") || "webgpu-first";
  const test = query.get("test") || "transfer";
  const kind = query.get("kind") || "rect";
  message("start", { order, test, kind });

  const Skia = loadLibraries(order);
  let device;
  let value;
  if (kind === "rect") value = Skia.XYWHRect(1, 2, 3, 4);
  else if (kind === "paint") value = Skia.Paint();
  else if (kind === "plain") value = { x: 1, y: 2, width: 3, height: 4 };
  else if (kind === "proto") value = null;
  else if (kind === "buffer") {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter");
    device = await adapter.requestDevice();
    value = device.createBuffer({
      label: "serializer-repro-buffer",
      size: 16,
      usage: GPUBufferUsage.COPY_DST,
    });
  } else throw new Error(`Unknown kind: ${kind}`);

  const brand = Object.prototype.toString.call(value);
  message("classify", {
    brand,
    webgpuAccepts: globalThis.__webgpuIsWebGPUObject
      ? globalThis.__webgpuIsWebGPUObject(value)
      : typeof value?.__webgpuBox === "function",
    skiaAccepts: typeof value?.__box === "function",
  });

  if (test === "direct") {
    let wrongBox;
    try {
      wrongBox = globalThis.__webgpuBox(value);
      message("direct-webgpu-box", {
        success: true,
        boxedWebGPU: wrongBox.__boxedWebGPU,
        brand: wrongBox.__brand,
      });
    } catch (error) {
      message("direct-webgpu-box", { success: false, error: String(error) });
    }
    if (wrongBox) {
      try {
        wrongBox.unbox();
        message("direct-webgpu-unbox", { success: true });
      } catch (error) {
        message("direct-webgpu-unbox", { success: false, error: String(error) });
      }
    }
    if (typeof value.__box === "function") {
      const correct = value.__box().unbox();
      message("direct-skia-unbox", {
        success: true,
        brand: Object.prototype.toString.call(correct),
        ...(kind === "rect" ? describeRect(correct) : {}),
      });
    }
    message("done", { order, test, kind });
    complete("Direct boxing complete; inspect SERIALIZER_REPRO logs.");
    device?.destroy();
    return;
  }
  if (test === "roundtrip") {
    message("schedule", { order, test, kind });
    scheduleOnUI(
      (object, objectKind, callback, onError) => {
        "worklet";
        try {
          const back =
            objectKind === "proto"
              ? Object.create({ marker: 1 }, { x: { value: 1, enumerable: true } })
              : object;
          scheduleOnRN(callback, back);
        } catch (error) {
          scheduleOnRN(onError, String(error));
        }
      },
      value,
      kind,
      (back) => {
        let result;
        if (kind === "buffer") result = { size: back.size, label: back.label };
        else if (kind === "paint") result = { strokeWidth: back.getStrokeWidth() };
        else if (kind === "proto") result = { x: back.x, marker: back.marker };
        else result = describeRect(back);
        message("received", { order, test, kind, result });
        message("done", { order, test, kind });
        complete(JSON.stringify(result));
        device?.destroy();
      },
      (error) => {
        message("worklet-error", { order, test, kind, error });
        complete(error);
      },
    );
    return;
  }
  if (test !== "transfer") throw new Error(`Unknown test: ${test}`);

  // Log the actual packer selected on the RN runtime without changing either
  // serializer's determine predicate or registration order.
  const webgpuBox = globalThis.__webgpuBox;
  globalThis.__webgpuBox = (object) => {
    message("pack", {
      owner: "WebGPU",
      brand: Object.prototype.toString.call(object),
    });
    return webgpuBox(object);
  };
  if (typeof value.__box === "function") {
    const skiaBox = value.__box;
    Object.defineProperty(value, "__box", {
      value: function () {
        message("pack", {
          owner: "Skia",
          brand: Object.prototype.toString.call(this),
        });
        return skiaBox.call(this);
      },
    });
  }

  const onSuccess = (result) => {
    message("received", { order, test, kind, result });
    message("done", { order, test, kind });
    complete(JSON.stringify(result));
    device?.destroy();
  };
  message("schedule", { order, test, kind });
  scheduleOnUI(
    (object, objectKind, callback) => {
      "worklet";
      let result;
      if (objectKind === "buffer")
        result = { size: object.size, label: object.label };
      else if (objectKind === "paint")
        result = { strokeWidth: object.getStrokeWidth() };
      else
        result = {
          x: object.x,
          y: object.y,
          width: object.width,
          height: object.height,
        };
      scheduleOnRN(callback, result);
    },
    value,
    kind,
    onSuccess,
  );
}

export default function App() {
  const [status, setStatus] = useState(
    "Open serializer-repro://run with order, test, and kind query parameters.",
  );
  useEffect(() => {
    const start = (url) => {
      if (url)
        run(url, setStatus).catch((error) => {
          message("setup-error", { error: String(error) });
          setStatus(String(error));
        });
    };
    Linking.getInitialURL().then(start);
    const listener = Linking.addEventListener("url", ({ url }) => start(url));
    return () => listener.remove();
  }, []);
  return (
    <View
      style={{
        flex: 1,
        padding: 24,
        paddingTop: 72,
        backgroundColor: "#102030",
      }}
    >
      <Text style={{ color: "white", fontSize: 18 }}>
        WebGPU / Skia serializer reproduction
      </Text>
      <Text style={{ color: "white", marginTop: 20 }}>{status}</Text>
    </View>
  );
}
