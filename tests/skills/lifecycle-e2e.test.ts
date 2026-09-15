import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillControlService } from "../../src/skills/service";

describe("Phase 20.57 Seed Demonstrations & Full Lifecycle E2E", () => {
  let tempHome: string;
  let service: SkillControlService;

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), "pao-skill-e2e-"));
    const dbPath = join(tempHome, "test-skills.sqlite");
    const fixtureRoot = join(tempHome, "remote-fixtures");
    service = new SkillControlService(dbPath, fixtureRoot);
  });

  afterAll(() => {
    service.db.close();
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // DEMO A: Local Skill Lifecycle & Drift Recovery
  test("Demo A: Local Skill (import -> scan -> publish -> deploy -> drift -> restore)", async () => {
    // 1. Create a local skill on disk
    const localSkillDir = join(tempHome, "sample-local-skill");
    mkdirSync(localSkillDir, { recursive: true });
    const originalSkillContent = `---
name: local-db-helper
displayName: Local Database Helper
version: 1.0.0
description: Procedures for local database management.
tags: db, local
---

# Local Database Helper
Guidance for local SQL query tuning.
`;
    writeFileSync(join(localSkillDir, "SKILL.md"), originalSkillContent, "utf8");

    // 2. Import
    const importRes = await service.importLocal(localSkillDir, { actor: "test-user" });
    expect(importRes.skill.id).toBe("local.local-db-helper");
    expect(importRes.version.version).toBe("1.0.0");

    // 3. Scan & Verify Risk
    const scanRes = service.scanSkill(importRes.version.id);
    expect(scanRes.level).toBe("low");

    // 4. Publish
    const publishedVersion = service.publishVersion(importRes.version.id, "test-user");
    expect(publishedVersion.immutable).toBe(true);

    // 5. Plan & Deploy to Codex
    const mockProject = join(tempHome, "mock-project");
    mkdirSync(mockProject, { recursive: true });

    const plan = await service.planDeployment(publishedVersion.id, {
      agentType: "codex",
      scope: "project",
      projectPath: mockProject,
    });
    expect(plan.canApply).toBe(true);

    const deployRes = await service.applyDeploymentPlan(plan.planId, "test-user");
    expect(deployRes.status).toBe("DEPLOYED");
    expect(existsSync(deployRes.target.targetPath)).toBe(true);
    expect(existsSync(join(deployRes.target.targetPath, "SKILL.md"))).toBe(true);

    // 6. Simulate Manual Drift: Operator directly edits the target file
    const targetSkillMd = join(deployRes.target.targetPath, "SKILL.md");
    writeFileSync(targetSkillMd, originalSkillContent + "\n-- DRIFTED MANUAL CHANGE --\n", "utf8");

    // 7. Drift Detection detects modification
    const driftRes = await service.checkDeploymentDrift(deployRes.deploymentId);
    expect(driftRes.inSync).toBe(false);
    expect(driftRes.driftType).toBe("MODIFIED");

    // 8. Restore from registry
    const restoreRes = await service.restoreDriftedDeployment(deployRes.deploymentId, "test-user");
    expect(restoreRes.status).toBe("DEPLOYED");

    // Verify restored file matches registry version
    const restoredContent = readFileSync(targetSkillMd, "utf8");
    expect(restoredContent).toBe(originalSkillContent);

    // Now in sync!
    const recheckDrift = await service.checkDeploymentDrift(deployRes.deploymentId);
    expect(recheckDrift.inSync).toBe(true);
    expect(recheckDrift.driftType).toBe("IN_SYNC");
  });

  // DEMO B: Marketplace Skill Discovery & Deployment to Multiple Agents
  test("Demo B: Marketplace Skill (search -> preview -> import -> scan -> publish -> deploy to 2 agents)", async () => {
    // 1. Search
    const searchResults = await service.searchMarketplace("postgres");
    expect(searchResults.length).toBeGreaterThan(0);
    const item = searchResults.find(s => s.id === "postgres-migration")!;
    expect(item).toBeDefined();

    // 2. Import exact source revision
    const importRes = await service.importFromMarketplace(item.id, { actor: "test-user" });
    expect(importRes.skill.slug).toBe("postgres-migration");

    // 3. Scan & Publish
    service.scanSkill(importRes.version.id);
    const pub = service.publishVersion(importRes.version.id, "test-user");
    expect(pub.immutable).toBe(true);

    // 4. Dry-run deployment to Claude Code
    const mockProject = join(tempHome, "mock-project-claude");
    mkdirSync(mockProject, { recursive: true });

    const dryRunPlan = await service.planDeployment(pub.id, {
      agentType: "claude-code",
      scope: "project",
      projectPath: mockProject,
    });
    expect(dryRunPlan.target.agentType).toBe("claude-code");
    expect(dryRunPlan.target.exists).toBe(false); // not written during dry-run

    // 5. Deploy to Claude Code
    const claudeDeploy = await service.applyDeploymentPlan(dryRunPlan.planId, "test-user");
    expect(claudeDeploy.status).toBe("DEPLOYED");
    expect(existsSync(claudeDeploy.target.targetPath)).toBe(true);

    // 6. Deploy same canonical skill to OpenCode
    const opencodeDeploy = await service.deployDirect(pub.id, {
      agentType: "opencode",
      scope: "project",
      projectPath: mockProject,
    });
    expect(opencodeDeploy.status).toBe("DEPLOYED");
    expect(existsSync(opencodeDeploy.target.targetPath)).toBe(true);

    // Verify both targets carry verified content
    expect(claudeDeploy.actualSha256).toBe(opencodeDeploy.actualSha256);
  });

  // DEMO C: Phase 20.56 Generated Skill Bridge
  test("Demo C: Capability Factory Generated Skill Bridge", async () => {
    const artifactDir = join(tempHome, "generated-cap-artifact");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "SKILL.md"),
      `---
name: adobe-stock-qc
displayName: Adobe Stock QC Inspector
version: 1.0.0
---

# Adobe Stock QC Inspector
Automated inspection checklist for commercial image submission.
`,
      "utf8",
    );

    const provenance = {
      capabilityId: "image.stock.qc",
      capabilityVersion: "2.1.0",
      recipe: "recipe-adobe-stock-inspection",
      author: "capability-factory-daemon",
      generatedAt: new Date().toISOString(),
      sourceHash: "sha256:fedcba987654321",
    };

    // Ingest through bridge
    const generatedRes = await service.importGenerated(
      "image.stock.qc",
      "2.1.0",
      artifactDir,
      provenance,
    );

    expect(generatedRes.version.manifest.source.type).toBe("GENERATED");
    expect(generatedRes.version.manifest.source.provenance?.capabilityId).toBe("image.stock.qc");
    expect(generatedRes.skill.trust_level).toBe("verified");

    // Scan
    const scan = service.scanSkill(generatedRes.version.id);
    expect(scan.level).toBe("low");

    // Publish & Deploy
    service.publishVersion(generatedRes.version.id);
    const deploy = await service.deployDirect(generatedRes.version.id, {
      agentType: "codex",
      scope: "user",
      homeDir: tempHome,
    });
    expect(deploy.status).toBe("DEPLOYED");
  });

  // DEMO D: Remote Node Deployment with Host-Key Pinning
  test("Demo D: Remote Node (host-key verify -> agent detect -> deploy -> verify hash)", async () => {
    const vpsRoot = join(tempHome, "vps-remote-root");
    mkdirSync(vpsRoot, { recursive: true });

    const nodeRecord = {
      id: "vps-test",
      name: "VPS Test Host",
      kind: "ssh" as const,
      hostname: "vps-test.internal",
      port: 22,
      username: "deployer",
      auth_ref: "secret://ssh/vps-test",
      host_key_fingerprint: "SHA256:7e+4VqQ8s/M0s/fakeFingerprintKeyPinned",
      environment: "staging" as const,
      status: "ONLINE" as const,
      allowed_roots: [vpsRoot],
      tags: ["staging", "vps"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    service.upsertNode(nodeRecord);

    // 1. Connection & Pinning Verification
    const conn = await service.testNodeConnection("vps-test");
    expect(conn.connected).toBe(true);

    // 2. Remote agent detection
    const agents = await service.sshTransport.detectRemoteAgents(nodeRecord);
    expect(agents.some(a => a.agentType === "codex")).toBe(true);

    // 3. Remote deploy
    const skill = service.listSkills()[0]!;
    const plan = await service.planDeployment(`${skill.id}@${skill.current_version}`, {
      agentType: "codex",
      scope: "project",
      projectPath: vpsRoot,
      nodeId: "vps-test",
    });

    const remoteDeploy = await service.sshTransport.deployRemoteSkill(nodeRecord, plan, {
      "SKILL.md": "# Remote Skill",
    });
    expect(remoteDeploy.status).toBe("DEPLOYED");

    // 4. Remote integrity verify
    const verify = await service.sshTransport.verifyRemoteSkill(
      nodeRecord,
      plan.target.targetPath,
      plan.manifest.integrity.content_sha256,
    );
    expect(verify.verified).toBe(true);
  });

  // Rollback Feature Verification
  test("Rollback: Reverts target to exact prior snapshot", async () => {
    const skillDir = join(tempHome, "rollback-test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Version 1.0.0 Content", "utf8");

    const v1 = await service.importLocal(skillDir, { slug: "rollback-skill", version: "1.0.0", publishImmediately: true });
    const mockProj = join(tempHome, "mock-rollback-proj");
    mkdirSync(mockProj, { recursive: true });

    // Deploy v1
    const dep1 = await service.deployDirect(v1.version.id, {
      agentType: "codex",
      scope: "project",
      projectPath: mockProj,
    });
    expect(dep1.status).toBe("DEPLOYED");
    expect(readFileSync(join(dep1.target.targetPath, "SKILL.md"), "utf8")).toBe("# Version 1.0.0 Content");

    // Mutate source to v2
    writeFileSync(join(skillDir, "SKILL.md"), "# Version 2.0.0 Content", "utf8");
    const v2 = await service.importLocal(skillDir, { slug: "rollback-skill", version: "2.0.0", publishImmediately: true });

    // Deploy v2 over v1 (automatically takes pre-deployment recovery snapshot)
    const dep2 = await service.deployDirect(v2.version.id, {
      agentType: "codex",
      scope: "project",
      projectPath: mockProj,
    });
    expect(dep2.status).toBe("DEPLOYED");
    expect(readFileSync(join(dep2.target.targetPath, "SKILL.md"), "utf8")).toBe("# Version 2.0.0 Content");

    // Rollback to prior snapshot!
    const rolled = await service.rollbackDeployment(dep2.deploymentId);
    expect(rolled.status).toBe("ROLLED_BACK");

    // Content should now be restored back to v1!
    expect(readFileSync(join(dep2.target.targetPath, "SKILL.md"), "utf8")).toBe("# Version 1.0.0 Content");
  });

  // Security Invariant Tests
  test("Security: Prevents silent overwrite of unmanaged existing skills", async () => {
    const unmanagedProject = join(tempHome, "unmanaged-proj");
    const targetDir = join(unmanagedProject, ".codex", "skills", "conflict-skill");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "SKILL.md"), "# Unmanaged User Skill (DO NOT OVERWRITE)");

    const skillDir = join(tempHome, "new-skill-source");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# New Pao Skill");

    const imported = await service.importLocal(skillDir, { slug: "conflict-skill", publishImmediately: true });

    // Plan should detect conflict
    const plan = await service.planDeployment(imported.version.id, {
      agentType: "codex",
      scope: "project",
      projectPath: unmanagedProject,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]).toContain("exists but is not managed by Pao-hubPro");

    // Refuses deployment when conflict exists
    expect(service.applyDeploymentPlan(plan.planId)).rejects.toThrow("Cannot execute deployment plan due to conflicts");
  });

  test("Security: Denies deployment of revoked skill", async () => {
    const skillDir = join(tempHome, "revoked-test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Revoked Test Skill");

    const imported = await service.importLocal(skillDir, { slug: "revoked-skill", publishImmediately: true });
    service.revokeSkill(imported.skill.id, "Security vulnerability found");

    const mockProj = join(tempHome, "mock-proj-revoked");
    expect(service.planDeployment(imported.version.id, {
      agentType: "codex",
      scope: "project",
      projectPath: mockProj,
    })).rejects.toThrow("Cannot deploy revoked skill");
  });
});

