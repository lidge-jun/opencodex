import { expect, test } from "bun:test";

type Step = {
  name?: string;
  run?: string;
};

type Job = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  needs?: string[];
  steps?: Step[];
};

test("Linux shards isolate the storage API runtime family into its own gated job", async () => {
  const text = await Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text();
  const workflow = Bun.YAML.parse(text) as {
    jobs?: Record<string, Job>;
  };

  const shardRun = workflow.jobs?.test?.steps?.find(
    step => step.name === "Test in fresh-process batches",
  )?.run ?? "";
  expect(shardRun).toContain("scripts/ci/run-bun-test-batches.sh");

  const batchHelper = await Bun.file(
    new URL("../scripts/ci/run-bun-test-batches.sh", import.meta.url),
  ).text();
  expect(batchHelper).toContain("tests/api-storage-policy*.test.ts");
  expect(batchHelper).toContain("tests/api-storage.test.ts");

  const storageJob = workflow.jobs?.["storage-policy"];
  expect(storageJob?.["runs-on"]).toBe("ubuntu-latest");
  expect(storageJob?.["timeout-minutes"]).toBe(5);

  const storageRun = storageJob?.steps?.find(
    step => step.name === "Test storage policy API",
  )?.run ?? "";
  const dedicatedFiles = [
    "tests/api-storage-policy-already-running.test.ts",
    "tests/api-storage-policy-mutation-busy.test.ts",
    "tests/api-storage-policy-put-race.test.ts",
    "tests/api-storage-policy-run.test.ts",
    "tests/api-storage-policy.test.ts",
    "tests/api-storage.test.ts",
  ];

  // Extract all test file paths from the run command
  const testPathPattern = /\.\/tests\/[a-z0-9-]+\.test\.ts/g;
  const actualFiles = (storageRun.match(testPathPattern) || [])
    .map(path => path.slice(2)) // Remove leading "./"
    .sort();

  const expectedFiles = [...dedicatedFiles].sort();
  expect(actualFiles).toEqual(expectedFiles);

  expect(storageRun).not.toContain("--shard");

  expect(workflow.jobs?.ci?.needs).toContain("storage-policy");
});
