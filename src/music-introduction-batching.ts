/** Experimental task sizing; never changes source or copyright requirements. */
export const introductionResearchProfiles = {
  light: {
    label: "轻量 · 每批 5 张 · 建议并行 1 路",
    albumsPerBatch: 5,
    maxConcurrentAlbums: 1,
    maxSourcesPerAlbum: 3,
    maxQueryRounds: 2,
  },
  balanced: {
    label: "均衡 · 每批 10 张 · 建议并行 2 路",
    albumsPerBatch: 10,
    maxConcurrentAlbums: 2,
    maxSourcesPerAlbum: 4,
    maxQueryRounds: 3,
  },
  capable: {
    label: "充足 · 每批 20 张 · 建议并行 4 路",
    albumsPerBatch: 20,
    maxConcurrentAlbums: 4,
    maxSourcesPerAlbum: 6,
    maxQueryRounds: 4,
  },
} as const;

export type IntroductionResearchProfile = keyof typeof introductionResearchProfiles;

export interface IntroductionResearchOptions {
  mode: "efficient";
  profile: IntroductionResearchProfile;
  batchNumber: number;
  totalBatches: number;
  albumsPerBatch: number;
  maxConcurrentAlbums: number;
  maxSourcesPerAlbum: number;
  maxQueryRounds: number;
  retryLimit: 1;
}

/** 只分割任务数组；身份字段、修订值和曲库顺序均原样保留。 */
export function partitionIntroductionTask<T extends { albums: unknown[] }>(
  task: T,
  profile: IntroductionResearchProfile,
  batchNumber = 1,
) {
  if (!Object.prototype.hasOwnProperty.call(introductionResearchProfiles, profile)) {
    throw new Error("请选择有效的 AI 批量档位：轻量、均衡或充足。");
  }
  if (!task || !Array.isArray(task.albums)) {
    throw new Error("专辑任务格式无效：缺少专辑清单。");
  }
  if (!task.albums.length) {
    throw new Error("当前范围没有待处理的专辑任务。");
  }
  const { albumsPerBatch, maxConcurrentAlbums, maxSourcesPerAlbum, maxQueryRounds } = introductionResearchProfiles[profile];
  const totalBatches = Math.ceil(task.albums.length / albumsPerBatch);
  if (!Number.isInteger(batchNumber) || batchNumber < 1 || batchNumber > totalBatches) {
    throw new Error(`批次编号必须是 1 至 ${totalBatches} 之间的整数。`);
  }
  const start = (batchNumber - 1) * albumsPerBatch;
  const options: IntroductionResearchOptions = {
    mode: "efficient",
    profile,
    batchNumber,
    totalBatches,
    albumsPerBatch,
    maxConcurrentAlbums,
    maxSourcesPerAlbum,
    maxQueryRounds,
    retryLimit: 1,
  };
  return {
    task: { ...task, albums: task.albums.slice(start, start + albumsPerBatch) },
    options,
  };
}

/** 附录只在用户启用临时批量模式时加入导出文档。 */
export function introductionResearchInstructions(options: IntroductionResearchOptions): string {
  return `## 本次批量效率设置（实验）

<!-- RHINE_RESEARCH_OPTIONS -->
\`\`\`json
${JSON.stringify(options, null, 2)}
\`\`\`
<!-- /RHINE_RESEARCH_OPTIONS -->

本次是第 ${options.batchNumber} / ${options.totalBatches} 批，最多 ${options.albumsPerBatch} 张。只处理本文件的 RHINE_ALBUM_TASK 清单，不自行扩展到其他批次或整个曲库。身份字段、排序与 expectedRevision 必须原样保留。

- 根据实际能力工作：最多并行处理 ${options.maxConcurrentAlbums} 张专辑；工具支持并行时才并行，不支持时按顺序串行，不能声称已启动不存在的并行任务。
- 每张专辑最多 ${options.maxQueryRounds} 轮搜索，最多读取 ${options.maxSourcesPerAlbum} 个来源；失败请求最多重试 ${options.retryLimit} 次。优先查找官方编辑导语或有署名的优质乐评，核实歌手、发行年份和专辑版本。找到足够的一篇优质导语／乐评就停止，不为凑来源数量继续搜索。
- 同一专辑、同一版本共享本批已读资料及链接，避免重复搜索；仍须核验每项身份，不把其他版本或其他专辑的文字误用过来。
- 每完成一张，立即把该条结果保存到当前结果文件，或在不支持文件的工具中给出可恢复的结果。结果中只包含已完成的条目，保存时保持 JSON 有效，不用未完成的空条目占位。完整批次完成后立即交付可导入的 introductions-result.json，不为了整个曲库等到最后。
- 预算耗尽后仍无法确认的条目标记为 uncertain，在 notes 说明已查的资料、未解决的身份问题或资料预算限制。不得把预算耗尽虚报为 not-found；也不得编造内容补齐数量。
- 本模式仅控制效率，不改变主文档的版权与全文使用规则。用户直接提供、具有明确允许全文转载的许可或属于公有领域的文字，才按主文档相应规则使用全文。公开可读取不等于允许全文转载；其他资料继续遵守原有短摘录、来源标注及署名边界，不忽略许可，不绕过付费墙，不将未获许可的全文改写成近似全文。
`;
}
