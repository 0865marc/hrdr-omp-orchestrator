import { expect, test } from "bun:test";
import packageJson from "../package.json";

test("package test script runs Bun's complete test discovery", () => {
  expect(packageJson.scripts.test).toBe("bun test");
});
