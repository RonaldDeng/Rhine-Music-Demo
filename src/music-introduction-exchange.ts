import agentGuide from "../docs/album-introductions/agent.md?raw";
import { escapeHtml as esc } from "./html";
import { introductionTaskDocument } from "./music-introduction-task";
import { introductionResearchInstructions, introductionResearchProfiles, partitionIntroductionTask } from "./music-introduction-batching";
import type { IntroductionResearchProfile } from "./music-introduction-batching";
import type { MusicAlbum, MusicIntroductionSource, MusicLibrary } from "./music-types";

interface ImportPreview {
  canApply: boolean;
  counts: { add: number; replace: number; skip: number; conflict: number };
  entries: {
    id: string; title: string; artist: string;
    action: "add" | "replace" | "skip" | "conflict";
    reason: string; description?: string; sources?: MusicIntroductionSource[];
    existingDescription?: string; existingSources?: MusicIntroductionSource[];
  }[];
}
interface ImportResult extends ImportPreview {
  imported: number;
  backup: string;
  library: MusicLibrary;
}
interface ExchangeOptions {
  request: <T>(url: string, body?: unknown) => Promise<T>;
  context: () => { connected: boolean; albumCount: number; revisionKey: string; selected?: MusicAlbum };
  applied: (library: MusicLibrary) => Promise<void>;
  notify: (message: string) => void;
}

const limit = 4 * 1024 * 1024;
const sourceKinds = { official: "官方资料", editorial: "编辑 / 乐评", reference: "参考资料" };
const actionNames = { add: "新增", replace: "替换", skip: "跳过", conflict: "需重新核对" };
// Page-session preference; refreshing the page turns the experiment off.
const batchSession: { enabled: boolean; profile: IntroductionResearchProfile } = { enabled: false, profile: "balanced" };

/** Source text is data. Never render imported HTML or executable URLs. */
export function introductionSourcesMarkup(sources: MusicIntroductionSource[]) {
  return sources.map(source => {
    let url: URL;
    try { url = new URL(source.url); } catch { return ""; }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const detail = [source.kind && sourceKinds[source.kind], source.author, source.publishedAt].filter(Boolean).join(" · ");
    return `<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source.name)} · 阅读原文 ↗</a>${detail ? `<small>${esc(detail)}</small>` : ""}${source.license ? `<small>${esc(source.license)}</small>` : ""}</li>`;
  }).join("");
}

export function introductionExchangeMarkup() {
  return `<div id="introduction-ai" class="introduction-ai">
    <h4>从任务导出到介绍导入</h4>
    <p>导出任务，交给能联网搜索的 AI，再导入结果。agent.md 已包含所选专辑清单和整理要求，无需另写提示词或配置接口。</p>
    <ol class="introduction-ai-steps">
      <li><strong>导出任务</strong><p>选择要补充的专辑。任务包含专辑、歌手、年份、曲目和已有介绍，不含本地路径、音乐或封面文件。</p>
        <label class="settings-row"><span>导出范围</span><select aria-label="AI 介绍导出范围" data-intro-scope><option value="missing">缺少介绍的专辑</option><option value="selected">当前专辑</option><option value="all">全部专辑</option></select></label>
        <label class="settings-row"><span>分批处理 · 实验<small>适合较大的曲库，刷新后关闭</small></span><input type="checkbox" data-intro-batch-enabled></label>
        <div data-intro-batch-options hidden>
          <label class="settings-row"><span>AI 任务容量</span><select aria-label="AI 任务容量" data-intro-batch-profile>${Object.entries(introductionResearchProfiles).map(([value, profile]) => `<option value="${value}" ${value === "balanced" ? "selected" : ""}>${esc(profile.label)}</option>`).join("")}</select></label>
          <label class="settings-row"><span>本次批次<small>每次导出一批；曲库变化后回到第 1 批</small></span><input type="number" min="1" step="1" value="1" aria-label="AI 任务批次" data-intro-batch-number></label>
          <p>按容量分批，建议 AI 并行检索并保存进度。处理速度取决于 AI 工具；每批都需核验来源与文本使用许可。</p>
        </div>
        <button type="button" class="text-button" data-intro-export>导出任务 · agent.md ↓</button>
      </li>
      <li><strong>交给 AI</strong><p>将 agent.md 交给 AI，寻找 Apple Music 等平台的编辑导语与署名乐评，并保留作者和来源。有明确授权或你提供的文本可收录全文，其他内容使用短摘录并附原文链接。无法核实的资料留空；完成后取得 introductions-result.json。</p></li>
      <li><strong>导入并预览</strong><p>选择 AI 返回的 JSON 文件，或粘贴内容。核对介绍和来源后再导入，导入前会自动备份。</p>
        <label class="introduction-ai-file">选择结果文件<input type="file" accept=".json,application/json" aria-label="选择 AI 介绍结果文件" data-intro-file></label>
        <textarea rows="5" aria-label="AI 介绍结果 JSON" placeholder="在这里粘贴 introductions-result.json 的内容" data-intro-result spellcheck="false"></textarea>
        <label class="settings-row"><span>替换已有介绍<small>关闭时只补充缺失内容</small></span><input type="checkbox" data-intro-replace></label>
        <button type="button" class="text-button" data-intro-preview>检查并预览</button>
      </li>
    </ol>
    <p class="introduction-ai-status" role="status" aria-live="polite" data-intro-status></p>
    <div class="introduction-ai-preview" data-intro-changes hidden></div>
    <button type="button" class="text-button" data-intro-reconcile hidden>核对旧结果的版本</button>
    <button type="button" class="primary-button" data-intro-apply hidden disabled>导入已预览的介绍</button>
  </div>`;
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A preview is tied to the exact input. Editing/replacing it invalidates Apply;
 * the server independently rechecks the current library revision at commit. */
export function mountIntroductionExchange(root: HTMLElement, options: ExchangeOptions) {
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const scope = find<HTMLSelectElement>("[data-intro-scope]");
  const input = find<HTMLTextAreaElement>("[data-intro-result]");
  const file = find<HTMLInputElement>("[data-intro-file]");
  const replace = find<HTMLInputElement>("[data-intro-replace]");
  const apply = find<HTMLButtonElement>("[data-intro-apply]");
  const reconcile = find<HTMLButtonElement>("[data-intro-reconcile]");
  const changes = find<HTMLElement>("[data-intro-changes]");
  const status = find<HTMLElement>("[data-intro-status]");
  const batchEnabled = find<HTMLInputElement>("[data-intro-batch-enabled]");
  const batchProfile = find<HTMLSelectElement>("[data-intro-batch-profile]");
  const batchNumber = find<HTMLInputElement>("[data-intro-batch-number]");
  batchEnabled.checked = batchSession.enabled;
  batchProfile.value = batchSession.profile;
  find<HTMLElement>("[data-intro-batch-options]").hidden = !batchEnabled.checked;
  let exportLibraryKey = options.context().revisionKey;
  let busy = false, revision = 0;
  let reviewed: { result: unknown; allowReplace: boolean; preview: ImportPreview; libraryKey: string } | undefined;
  const connectionMessage = "连接本地音乐服务并添加音乐文件夹后，即可导出任务、导入介绍。演示模式不提供这些操作。";
  const message = (value: string) => { if (root.isConnected) status.textContent = value; };
  const refresh = () => {
    const context = options.context();
    if (exportLibraryKey !== context.revisionKey) { batchNumber.value = "1"; exportLibraryKey = context.revisionKey; }
    if (reviewed && reviewed.libraryKey !== context.revisionKey) {
      revision++; reviewed = undefined; changes.hidden = true; apply.hidden = true; reconcile.hidden = true;
      message("曲库或介绍已发生变化，请重新检查并预览结果。");
    }
    if (!context.connected && !status.textContent) message(connectionMessage);
    else if (context.connected && status.textContent === connectionMessage) message("");
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button,input,select,textarea"))
      control.disabled = busy;
    find<HTMLButtonElement>("[data-intro-export]").disabled = busy || !context.connected || !context.albumCount;
    find<HTMLButtonElement>("[data-intro-preview]").disabled = busy || !context.connected || !input.value.trim();
    scope.querySelector<HTMLOptionElement>('[value="selected"]')!.disabled = !context.selected;
    apply.disabled = busy || !context.connected || !reviewed?.preview.canApply;
    reconcile.disabled = busy || !context.connected || !reviewed?.preview.counts.conflict;
  };
  const invalidate = () => {
    revision++; reviewed = undefined;
    changes.hidden = true; changes.replaceChildren(); apply.hidden = true; reconcile.hidden = true;
    message(input.value.trim() ? "结果已更新，请先检查并预览。" : ""); refresh();
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true; refresh();
    try { await work(); }
    catch (error) { message((error as Error).message); }
    finally { busy = false; refresh(); }
  };
  input.addEventListener("input", invalidate);
  replace.addEventListener("change", invalidate);
  batchEnabled.addEventListener("change", () => {
    batchSession.enabled = batchEnabled.checked;
    find<HTMLElement>("[data-intro-batch-options]").hidden = !batchEnabled.checked;
    batchNumber.value = "1";
  });
  scope.addEventListener("change", () => { batchNumber.value = "1"; });
  batchProfile.addEventListener("change", () => { batchSession.profile = batchProfile.value as IntroductionResearchProfile; batchNumber.value = "1"; });
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const current = ++revision;
    reviewed = undefined; changes.hidden = true; apply.hidden = true; reconcile.hidden = true;
    void run(async () => {
      if (selected.size > limit) throw new Error("结果文件超过 4 MiB，请让 AI 分批返回。");
      const value = await selected.text();
      if (!root.isConnected || current !== revision) return;
      input.value = value; invalidate();
      message(`已读取 ${selected.name}，请先检查并预览。`);
    });
    file.value = "";
  });
  find<HTMLButtonElement>("[data-intro-export]").addEventListener("click", () => void run(async () => {
    const { selected, revisionKey: libraryKey } = options.context();
    const batchSelection = batchEnabled.checked
      ? { profile: batchProfile.value as IntroductionResearchProfile, number: Number(batchNumber.value) } : undefined;
    if (scope.value === "selected" && !selected) throw new Error("请先选择一张专辑。");
    const query = new URLSearchParams({ scope: scope.value });
    if (scope.value === "selected") query.set("albumId", selected!.id);
    message("正在准备专辑清单…");
    const task = await options.request<{ albums: unknown[] }>(`/api/library/introductions/task?${query}`);
    if (!root.isConnected) return;
    if (libraryKey !== options.context().revisionKey) { message("曲库或介绍已发生变化，请确认范围和批次后重新导出。"); return; }
    if (!task.albums.length) { message("这个范围内没有需要补充的专辑，可选择当前专辑或全部专辑。"); return; }
    const batch = batchSelection ? partitionIntroductionTask(task, batchSelection.profile, batchSelection.number) : undefined;
    const guide = batch ? `${agentGuide}\n\n${introductionResearchInstructions(batch.options)}` : agentGuide;
    const exportTask = batch?.task ?? task;
    download("agent.md", introductionTaskDocument(guide, exportTask, window.location.origin), "text/markdown;charset=utf-8");
    message(`已导出 ${exportTask.albums.length} 张专辑的任务${batch ? `（第 ${batch.options.batchNumber} / ${batch.options.totalBatches} 批）` : ""}。将 agent.md 交给 AI 即可开始。`);
  }));
  const previewInput = async (prefix = "") => {
    reviewed = undefined; apply.hidden = true; changes.hidden = true; reconcile.hidden = true;
    if (new Blob([input.value]).size > limit) throw new Error("结果超过 4 MiB，请分批导入。");
    let result: unknown;
    try { result = JSON.parse(input.value.replace(/^\uFEFF/, "")); }
    catch { throw new Error("无法读取 JSON。请粘贴完整结果，不要包含 ``` 代码围栏或额外说明。"); }
    const allowReplace = replace.checked, current = revision, libraryKey = options.context().revisionKey;
    message("正在核对专辑身份、来源和已有内容…");
    const preview = await options.request<ImportPreview>("/api/library/introductions/import-preview", { result, allowReplace });
    if (!root.isConnected || current !== revision) return;
    if (libraryKey !== options.context().revisionKey) { message("曲库或介绍已发生变化，请重新检查并预览结果。"); return; }
    reviewed = { result, allowReplace, preview, libraryKey };
    const count = preview.counts;
    changes.innerHTML = `<p>新增 ${count.add} · 替换 ${count.replace} · 跳过 ${count.skip} · 冲突 ${count.conflict}</p><div class="introduction-ai-entries">${preview.entries.map(entry => `<details><summary><span>${actionNames[entry.action]}</span> ${esc(entry.title)}<small>${esc(entry.artist)}</small></summary><p>${esc(entry.reason)}</p>${entry.existingDescription ? `<div class="introduction-ai-existing"><small>当前已保存的介绍</small><div class="introduction-ai-copy">${esc(entry.existingDescription)}</div>${entry.existingSources?.length ? `<ul class="introduction-sources">${introductionSourcesMarkup(entry.existingSources)}</ul>` : ""}</div><small>本次新介绍</small>` : ""}${entry.description ? `<div class="introduction-ai-copy">${esc(entry.description)}</div>` : ""}${entry.sources?.length ? `<ul class="introduction-sources">${introductionSourcesMarkup(entry.sources)}</ul>` : ""}</details>`).join("")}</div>`;
    changes.hidden = false; apply.hidden = !preview.canApply;
    apply.textContent = `导入 ${count.add + count.replace} 张专辑介绍`;
    reconcile.hidden = count.conflict === 0;
    message(prefix + (preview.canApply ? "预览已就绪。展开条目核对正文与来源后，点击导入。" : count.conflict ? "有版本冲突，请先核对旧结果。只有介绍发生变化、专辑和曲目未变，且本机有记录可核实时，才能更新版本标识并重新预览。" : "没有可导入的内容，请查看跳过原因。要更新已有介绍，请开启“替换已有介绍”后重新预览。"));
  };
  find<HTMLButtonElement>("[data-intro-preview]").addEventListener("click", () => void run(() => previewInput()));
  reconcile.addEventListener("click", () => {
    const draft = reviewed, current = revision;
    if (!draft?.preview.counts.conflict) return;
    void run(async () => {
      reviewed = undefined; apply.hidden = true; reconcile.hidden = true;
      message("正在核对旧版本记录，介绍尚未导入…");
      const checked = await options.request<{ result: unknown; rebound: number; unresolved: { id: string; reason: string }[] }>("/api/library/introductions/reconcile", { result: draft.result });
      if (!root.isConnected || current !== revision) return;
      input.value = JSON.stringify(checked.result, null, 2); revision++;
      const unresolved = checked.unresolved.length ? `仍有 ${checked.unresolved.length} 项无法确认，请重新导出受影响专辑。${checked.unresolved.slice(0, 2).map(item => item.reason).join("；")}\n` : "";
      await previewInput(`已核对并更新 ${checked.rebound} 项旧版本标识，正文未改写。${unresolved}\n`);
    });
  });
  apply.addEventListener("click", () => {
    const draft = reviewed;
    if (!draft?.preview.canApply) return;
    void run(async () => {
      reviewed = undefined; apply.hidden = true;
      message("正在备份并导入介绍…");
      const result = await options.request<ImportResult>("/api/library/introductions/import", { result: draft.result, allowReplace: draft.allowReplace });
      await options.applied(result.library);
      changes.hidden = true;
      message(`已导入 ${result.imported} 张专辑介绍，原内容已自动备份。可到专辑的 02 介绍页阅读。`);
      options.notify(`已导入 ${result.imported} 张专辑介绍，原内容已备份。`);
    });
  });
  refresh();
  return { refresh, focusSelected() {
    if (options.context().selected) scope.value = "selected";
    root.scrollIntoView({ block: "start" });
    scope.focus({ preventScroll: true });
  } };
}
