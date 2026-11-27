import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export const knowledgeQuestion = '通电啥时候能测';
export const knowledgeTitle = '低温测量准备';
export const knowledgeClause = 'At ambient temperatures below 10 C, preheat for 30 minutes before measuring.';

export function knowledgeCompletion(blocks) {
  const block = blocks.find(({ text }) => text.includes(knowledgeClause));
  return JSON.stringify({ points: block ? [{
    title: knowledgeTitle,
    aliases: [knowledgeQuestion],
    answer: '预热 30 分钟后开始测量。',
    conditions: '环境温度低于 10°C。',
    sources: [block.id],
  }] : [] });
}

export function knowledgeCitation(system) {
  const evidence = [...system.matchAll(/^\[(S\d+)\] [^\n]+\n/gm)];
  const index = evidence.findIndex((entry, position) => system
    .slice(entry.index + entry[0].length, evidence[position + 1]?.index).includes(knowledgeClause));
  return index >= 0 ? `[${evidence[index][1]}]` : null;
}

export async function waitForKnowledge(read, status) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (result.status === status) return result;
    await setTimeout(40);
  }
  assert.fail(`知识点未进入 ${status} 状态`);
}
