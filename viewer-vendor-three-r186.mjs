import * as ThreeR186 from "three-r186/webgpu";
import { GaussianSplat } from "three-r186/addons/objects/GaussianSplat.js";
import { createNativeAppearance, updateNativeGeometry, disposeNativeSplat } from "./viewer-three-native.mjs";

// Isolated from Spark's Three.js. Follow the official splat example's encoded
// compositing; the application's appearance calculations remain linear-sRGB.
ThreeR186.ColorManagement.workingColorSpace = ThreeR186.SRGBColorSpace;
globalThis.__SPATIAL_LOOKDEV_THREE_R186__ = { ...ThreeR186, GaussianSplat,
  createNativeAppearance, updateNativeGeometry, disposeNativeSplat };
