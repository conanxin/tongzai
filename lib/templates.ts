import type { InteractionTemplate, RoomSnapshot, TemplateId } from './model';

export const templates: InteractionTemplate[] = [
  { id: 'conversation', name: '自在对话', subtitle: '从一句近况，聊到彼此心里。', description: '给熟悉的人一段认真倾听的时间。用轻松的提示打开话题，随时跳过不想回答的问题。', color: '#b5d7bf', icon: 'sparkles', tag: '慢慢聊 · 4 个环节', steps: [
    { title: '先说说此刻', eyebrow: '轻轻开始', prompt: '如果用一个天气形容今天的自己，你会选什么？', hint: '从想说的人开始。另一位先听，不急着给建议。', weight: 20 },
    { title: '交换一个片刻', eyebrow: '分享近况', prompt: '最近有什么小事，让你觉得「这一刻真好」？', hint: '轮流分享。也可以换一个你们都感兴趣的话题。', weight: 30 },
    { title: '再靠近一点', eyebrow: '认真倾听', prompt: '最近有什么希望被理解的事，或者想一起完成的小愿望？', hint: '只分享愿意分享的内容。任何时候都可以暂停或跳过。', weight: 35 },
    { title: '留下一点余温', eyebrow: '好好收尾', prompt: '今天听见的哪一句话，你想记住？', hint: '一起写一句记录，也约一个下次见面的时间。', weight: 15 },
  ] },
  { id: 'reading', name: '一起共读', subtitle: '同一段文字，两种看见。', description: '带着一本书、一个段落或一个问题进来。在阅读与交流之间，发现另一种理解。', color: '#afcde8', icon: 'book', tag: '交换理解 · 5 个环节', steps: [
    { title: '翻到同一页', eyebrow: '安静阅读', prompt: '选一个段落，或者各自回想最近读到的一句话。', hint: '把书名、章节或链接放进共同记录，便于彼此定位。', weight: 15 },
    { title: '第一种理解', eyebrow: '一人分享', prompt: '这段文字里，哪个细节最先吸引了你？为什么？', hint: '请一位先分享，另一位先听，也可以记下想追问的问题。', weight: 25 },
    { title: '第二种看见', eyebrow: '换一人说', prompt: '你的理解有什么相同与不同？它让你想起什么？', hint: '把话筒交给另一位。不同的感受都值得被听见。', weight: 25 },
    { title: '把问题打开', eyebrow: '自由讨论', prompt: '如果向作者追问一个问题，你们会问什么？', hint: '可以联系另一本书、一个场景，或者自己的经历。', weight: 25 },
    { title: '带走一个问题', eyebrow: '共同记录', prompt: '记下一个收获，或者留待下一次讨论的问题。', hint: '记录由你们手动保存，不会自动改写个人笔记。', weight: 10 },
  ] },
  { id: 'rehearsal', name: '对词排练', subtitle: '把文字，慢慢变成声音。', description: '选一个短场景，分配角色，一起对词、讨论和再来一遍。把修改点留在共同记录。', color: '#d9bde2', icon: 'mic', tag: '一起创作 · 4 个环节', steps: [
    { title: '走进这个场景', eyebrow: '选段与分工', prompt: '确认本轮的剧本片段，分配角色，说说人物此刻想要什么。', hint: '在共同记录粘贴台词或稿件链接。先约好这一轮关注的地方。', weight: 20 },
    { title: '先完整来一遍', eyebrow: '第一次对词', prompt: '按自己的理解，完整读一遍选定的片段。', hint: '先保持交流的连续性；需要调整的地方可以记下来。', weight: 35 },
    { title: '听见另一种表达', eyebrow: '讨论与重来', prompt: '选一句最值得调整的台词，试试另一种语气与节奏。', hint: '讨论人物的意图。也可以交换角色，再听一次。', weight: 30 },
    { title: '记住这一版', eyebrow: '整理修改', prompt: '记下本次保留的表达和下一次想继续打磨的地方。', hint: '本房间用于通话与排练，不会自动录制音频。', weight: 15 },
  ] },
];

export function getTemplate(id: TemplateId | string): InteractionTemplate {
  return templates.find(t => t.id === id) ?? templates[0];
}
export function stepDurationMs(room: Pick<RoomSnapshot, 'templateId' | 'durationMinutes'>, index: number): number {
  const template = getTemplate(room.templateId);
  return Math.round(room.durationMinutes * 60_000 * (template.steps[index]?.weight ?? 0) / 100);
}
