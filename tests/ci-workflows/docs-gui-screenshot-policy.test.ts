import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const CASES = [
  {
    path: "docs-site/src/content/docs/fr/contributing.md",
    policy: "- Si la pull request modifie des fichiers sous `gui/`, ajoutez une capture d’écran de la modification de l’interface dans sa description. `enforce-target` est réexécuté après chaque modification de la description jusqu’à sa présence. Glissez l’image dans la description au lieu de la committer sur la branche : elle serait incluse dans le squash merge vers `dev`. Pour un envoi en ligne de commande, les responsables utilisent la branche `pr-assets` avec un lien vers le SHA du commit.",
  },
  {
    path: "docs-site/src/content/docs/tr/contributing.md",
    policy: "- Çekme isteği `gui/` altındaki dosyaları değiştiriyorsa UI değişikliğinin ekran görüntüsünü açıklamaya ekleyin. `enforce-target`, ekran görüntüsü eklenene kadar açıklama düzenlemelerinde yeniden çalışır. Görseli dala commit etmek yerine açıklamaya sürükleyin: aksi hâlde squash merge ile `dev` dalına taşınır. Komut satırından yükleyen bakımcılar `pr-assets` dalını kullanır ve commit SHA'sına bağlantı verir.",
  },
  {
    path: "docs-site/src/content/docs/zh-tw/contributing.md",
    policy: "- 若 pull request 變更 `gui/` 下的檔案，請在描述中附上 UI 變更的螢幕截圖；`enforce-target` 會在 描述編輯時重新執行，直到附上截圖為止。請將圖片拖曳至描述中，不要 commit 到 PR 分支：否則 squash merge 會將圖片帶入 `dev`。透過命令列上傳的維護者應使用 `pr-assets` 分支，並以 commit SHA 連結圖片。",
  },
  {
    path: "MAINTAINERS.md",
    policy: "empty, thin, or malformed descriptions; PRs that change files under `gui/` must include a screenshot of the UI change in the description. Drag the image into the description instead of committing it to the PR branch; command-line uploads use the `pr-assets` branch and a commit-SHA link.",
  },
] as const;

test("GUI screenshot contributor guidance follows the changed-path gate and keeps images off PR branches", async () => {
  for (const { path, policy } of CASES) {
    const text = (await Bun.file(repoPath(path)).text()).replace(/\s+/g, " ");
    expect(text.includes(policy), path).toBe(true);
  }
});
