import {
  countWords,
  db,
  nowIso,
  syncNoteFts,
  todayKey,
  uid,
  upsertConcept,
} from '../db.js';

export function seedSampleData() {
  const now = nowIso();
  const catCs = uid();
  const catCog = uid();
  const catMath = uid();

  const categories = [
    { id: catCs, name: '计算机科学', color: '#3B5BDB', icon: 'cpu', desc: '操作系统、网络与算法核心原理' },
    { id: catCog, name: '认知与学习法', color: '#0F766E', icon: 'brain', desc: '记忆科学、费曼技巧与高效思维模型' },
    { id: catMath, name: '概率与线性代数', color: '#B45309', icon: 'sigma', desc: '机器学习与数据分析数学基石' },
  ];

  for (const c of categories) {
    db.prepare(
      `INSERT INTO categories (id, name, color, icon, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(c.id, c.name, c.color, c.icon, c.desc, now);
  }

  const note1Id = uid();
  const note2Id = uid();
  const note3Id = uid();

  const sampleNotes = [
    {
      id: note1Id,
      title: 'TCP 三次握手与四次挥手核心原理',
      categoryId: catCs,
      tags: ['计算机网络', 'TCP', '高频考点'],
      content: `# TCP 三次握手与四次挥手核心原理

## 1. 为什么建立连接需要「三次握手」？
TCP 是面向连接的可靠传输协议。三次握手的核心目的有两个：
1. **确认双方的发送能力与接收能力都正常**；
2. **同步初始序列号（ISN）**，防止历史失效的连接请求突然到达服务端造成资源浪费。

### 握手流程
- **第一次握手**：客户端发送 \`SYN=1, seq=x\`，进入 \`SYN_SENT\` 状态。
- **第二次握手**：服务端回复 \`SYN=1, ACK=1, seq=y, ack=x+1\`，进入 \`SYN_RCVD\` 状态。
- **第三次握手**：客户端回复 \`ACK=1, seq=x+1, ack=y+1\`，双方进入 \`ESTABLISHED\` 状态。

> 关键思考：如果只有两次握手，一个在网络中滞留的旧 \`SYN\` 到达服务端，服务端直接建立连接并分配资源，而客户端根本无意通信，就会导致服务端白白等待。

## 2. 为什么断开连接需要「四次挥手」？
因为 TCP 是**全双工**通信，每个方向必须独立关闭。
- 客户端发 \`FIN\` 表示「我不再发送数据了，但仍可接收」；
- 服务端先回 \`ACK\`，待自身数据全部发送完毕后，再发自己的 \`FIN\`；
- 客户端回复最终 \`ACK\` 后，必须进入 **\`TIME_WAIT\` 状态等待 \`2MSL\`**。

## 3. TIME_WAIT 等待 2MSL 的两大原因
1. 确保最后一个 \`ACK\` 能顺利到达服务端（若丢失，服务端会重传 \`FIN\`）；
2. 让本次连接产生的所有滞留报文在网络中自然消逝，避免干扰后续复用相同四元组的新连接。`,
      summary: {
        abstract:
          '本文系统梳理了 TCP 协议三次握手建立连接与四次挥手断开连接的底层机制，重点解释了防止历史失效连接、全双工独立关闭以及 TIME_WAIT 等待 2MSL 的工程原因。',
        keyPoints: [
          '三次握手同时确认双方收发能力并同步初始序列号 ISN',
          '两次握手无法防御滞留旧 SYN 报文导致的资源空耗',
          'TCP 全双工特性决定关闭连接需要四次挥手分别终止双向数据流',
          '主动关闭方进入 TIME_WAIT 等待 2MSL 以保证最终 ACK 可靠与旧包消逝',
        ],
        concepts: [
          { name: '三次握手', definition: 'TCP 建立可靠连接并同步双方初始序列号的三步交互过程' },
          { name: '四次挥手', definition: 'TCP 全双工通道分别关闭双向数据流的四步断开过程' },
          { name: 'TIME_WAIT', definition: '主动关闭方在发出最后 ACK 后等待 2MSL 的保护状态' },
          { name: '全双工通信', definition: '通信双方可以同时独立进行数据发送和接收的传输模式' },
        ],
        outline: ['1. 三次握手目的与状态转移', '2. 四次挥手与全双工关闭', '3. TIME_WAIT 与 2MSL 机制'],
        suggestedCategory: '计算机科学',
        suggestedTags: ['计算机网络', 'TCP', '传输层'],
        difficulty: '进阶',
      },
    },
    {
      id: note2Id,
      title: '间隔重复（SM-2）与费曼学习法的协同机制',
      categoryId: catCog,
      tags: ['学习科学', '记忆曲线', '主动回忆'],
      content: `# 间隔重复与费曼学习法的协同机制

## 1. 被动重读的「熟练度错觉」
反复划线、重复阅读教材往往会制造大脑的**流畅度错觉**——你觉得“眼熟”，但一旦合上书本就无法独立输出。真正牢固的记忆来自**提取练习（Active Recall）**。

## 2. 间隔重复与 SM-2 算法
基于艾宾浩斯遗忘曲线，在记忆「即将遗忘但尚未完全遗忘」的临界点复习，强化效果最佳。
SM-2 算法为每张记忆卡片维护三个核心参数：
- **难度因子 $EF$（Ease Factor）**：初始为 $2.5$，根据回忆流畅度动态调整；
- **复习间隔 $I$**：首次复习 $1$ 天，第二次 $4$ 天，之后按 $I_n = I_{n-1} \times EF$ 递增；
- **连胜次数 $n$**：一旦忘记则重置为 $0$，立刻重新巩固。

## 3. 费曼学习法四步闭环
1. **选定概念**：锁定一个核心知识模块；
2. **以教代学**：用通俗直白的话讲给外行听；
3. **定位盲区**：讲卡壳、只能背术语的地方就是理解漏洞；
4. **简化类比**：回归原典补齐漏洞，并用生活中的类比重构表达。

> 最佳组合：用**费曼学习法**打通「理解层」，用**间隔重复闪卡**锁死「记忆层」。`,
      summary: {
        abstract:
          '对比被动重读的熟练度错觉，阐述提取练习、SM-2 间隔重复算法核心公式及费曼学习法四步闭环，并提出理解层与记忆层双轮驱动的高效学习策略。',
        keyPoints: [
          '主动提取（Active Recall）比被动重复阅读更能建立长期记忆痕迹',
          'SM-2 算法通过难度因子 EF 与递增间隔在遗忘临界点安排复习',
          '费曼学习法通过“以教代学”精准暴露概念理解盲区',
          '费曼负责深度理解，间隔重复负责抗遗忘巩固',
        ],
        concepts: [
          { name: '主动回忆', definition: '不看答案主动从大脑中提取信息的学习方法，显著优于被动重读' },
          { name: 'SM-2算法', definition: '根据回忆评分动态计算下一次最佳复习间隔的遗忘曲线算法' },
          { name: '费曼学习法', definition: '通过通俗讲授他人来发现并填补知识盲区的深度学习方法' },
          { name: '熟练度错觉', definition: '因反复阅读感到熟悉而误以为已经掌握知识的认知偏差' },
        ],
        outline: ['1. 熟练度错觉与主动回忆', '2. SM-2 间隔重复参数与原理', '3. 费曼学习法四步闭环'],
        suggestedCategory: '认知与学习法',
        suggestedTags: ['学习科学', '费曼技巧', '间隔重复'],
        difficulty: '基础',
      },
    },
    {
      id: note3Id,
      title: '贝叶斯定理：先验、似然与后验的直觉理解',
      categoryId: catMath,
      tags: ['概率论', '贝叶斯', '公式'],
      content: `# 贝叶斯定理：先验、似然与后验的直觉理解

## 1. 核心公式
$$P(A|B) = \frac{P(B|A) \cdot P(A)}{P(B)}$$

其中：
- **$P(A)$ 先验概率（Prior）**：在看到新证据 $B$ 之前，对假设 $A$ 的初始信念；
- **$P(B|A)$ 似然度（Likelihood）**：如果假设 $A$ 为真，观察到证据 $B$ 的可能性；
- **$P(A|B)$ 后验概率（Posterior）**：综合新证据 $B$ 后更新得到的信念；
- **$P(B)$ 边际证据（Evidence）**：归一化常数，满足 $P(B) = P(B|A)P(A) + P(B|\neg A)P(\neg A)$。

## 2. 经典反直觉案例：罕见病检测
假设某种疾病发病率 $P(D) = 0.001$（千分之一），检测灵敏度 $P(+|D) = 99\%$，假阳性率 $P(+|\neg D) = 1\%$。
若某人检测呈阳性，其真正患病概率为：
$$P(D|+) = \frac{0.99 \times 0.001}{0.99 \times 0.001 + 0.01 \times 0.999} \approx 9.02\%$$

> 核心洞见：当基础率（先验概率）极低时，即使检测准确率高达 99%，大量健康人群产生的假阳性依然会远超真阳性。这就是**基率谬误（Base Rate Fallacy）**。`,
      summary: {
        abstract:
          '从直觉层面解析贝叶斯定理的四大组成部分，并借由罕见病检测的经典案例揭示忽略先验概率所导致的基率谬误。',
        keyPoints: [
          '贝叶斯更新本质是「后验 ∝ 似然 × 先验」',
          '边际证据 P(B) 通过全概率公式展开用于归一化',
          '极低先验概率下，高准确率检测仍可能伴随大量假阳性',
          '避免基率谬误是科学推理与数据分析的关键习惯',
        ],
        concepts: [
          { name: '贝叶斯定理', definition: '结合先验信念与新证据似然度动态更新后验概率的核心定理' },
          { name: '先验概率', definition: '在获得当前观测证据之前对事件发生可能性的初始估计' },
          { name: '基率谬误', definition: '人们在做概率判断时忽略事件基础发生率而过度依赖局部特征的认知偏误' },
        ],
        outline: ['1. 贝叶斯公式四要素', '2. 罕见病检测数值推导', '3. 基率谬误启示'],
        suggestedCategory: '概率与线性代数',
        suggestedTags: ['概率论', '贝叶斯', '决策思维'],
        difficulty: '进阶',
      },
    },
  ];

  for (const n of sampleNotes) {
    db.prepare(
      `INSERT INTO notes (id, title, content, summary_json, category_id, tags, source_type, word_count, is_pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?)`
    ).run(
      n.id,
      n.title,
      n.content,
      JSON.stringify(n.summary),
      n.categoryId,
      JSON.stringify(n.tags),
      countWords(n.content),
      n.id === note1Id ? 1 : 0,
      now,
      now
    );
    syncNoteFts(n.id, n.title, n.content, n.tags);

    const conceptIds: Record<string, string> = {};
    for (const c of n.summary.concepts) {
      conceptIds[c.name] = upsertConcept(c.name, c.definition, n.categoryId, n.id);
    }
    // Create simple internal links
    const names = n.summary.concepts.map((c) => c.name);
    for (let i = 0; i < names.length - 1; i++) {
      db.prepare(
        `INSERT OR IGNORE INTO concept_links (id, source_id, target_id, relation, weight) VALUES (?, ?, ?, ?, 1.0)`
      ).run(uid(), conceptIds[names[0]], conceptIds[names[i + 1]], '关联');
    }
  }

  // Adjust mastery scores so weak-point diagnosis looks insightful immediately
  db.prepare(`UPDATE concepts SET mastery_score = 0.35, quiz_attempts = 3, quiz_correct = 1 WHERE name = 'TIME_WAIT'`).run();
  db.prepare(`UPDATE concepts SET mastery_score = 0.42, quiz_attempts = 2, quiz_correct = 1 WHERE name = '基率谬误'`).run();
  db.prepare(`UPDATE concepts SET mastery_score = 0.85, quiz_attempts = 4, quiz_correct = 4 WHERE name = '三次握手'`).run();
  db.prepare(`UPDATE concepts SET mastery_score = 0.78, quiz_attempts = 3, quiz_correct = 3 WHERE name = '主动回忆'`).run();

  // Sample Flashcards (due immediately so user can test Spaced Repetition right away!)
  const sampleCards = [
    {
      noteId: note1Id,
      catId: catCs,
      concept: 'TIME_WAIT',
      front: 'TCP 四次挥手中，主动关闭方为什么必须进入 TIME_WAIT 状态并等待 2MSL？',
      back: '1. 确保最后一个 ACK 能到达对端（若丢失可响应对端重传的 FIN）；\n2. 让旧连接在网络中滞留的所有报文自然消逝，避免干扰后续复用的新连接。',
      hint: '从「最后ACK可靠性」和「旧报文消逝」两个角度思考',
    },
    {
      noteId: note2Id,
      catId: catCog,
      concept: 'SM-2算法',
      front: '为什么「被动重复阅读」往往效率低下，而「主动回忆 + 间隔重复」更有效？',
      back: '被动重读易产生「熟练度错觉」；主动回忆强迫大脑提取记忆通路，在遗忘临界点重复提取能最大化强化长期记忆巩固。',
      hint: '想想“眼熟 ≠ 掌握”',
    },
    {
      noteId: note3Id,
      catId: catMath,
      concept: '基率谬误',
      front: '在准确率 99% 的罕见病检测中，为什么阳性者实际患病率可能只有约 9%？',
      back: '因为疾病先验发病率（基率）极低（如 0.1%），庞大健康人群产生的 1% 假阳性绝对人数远超真阳性人数。',
      hint: '对比「真阳性人数」与「假阳性人数」',
    },
  ];

  for (const card of sampleCards) {
    db.prepare(
      `INSERT INTO flashcards (id, note_id, category_id, concept_name, front, back, hint, next_review_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uid(), card.noteId, card.catId, card.concept, card.front, card.back, card.hint, now, now, now);
  }

  // Sample Mistake (due immediately)
  db.prepare(
    `INSERT INTO mistakes (
      id, note_id, concept_name, type, stem, options_json, correct_answer, wrong_answer,
      explanation, ai_diagnosis, status, wrong_count, next_review_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'single', ?, ?, 'C', 'B', ?, ?, 'unmastered', 2, ?, ?, ?)`
  ).run(
    uid(),
    note1Id,
    'TIME_WAIT',
    '关于 TCP 断开连接时的 TIME_WAIT 状态，以下说法最准确的是？',
    JSON.stringify([
      'A. 服务端和客户端在四次挥手结束后都会进入 TIME_WAIT 状态',
      'B. TIME_WAIT 只需等待 1MSL，用于等待服务端发送 FIN 报文',
      'C. 主动关闭方进入 TIME_WAIT 并等待 2MSL，以防最后一个 ACK 丢失及旧连接报文滞留',
      'D. 可以通过将 TIME_WAIT 设为 0 来彻底消除网络延迟问题',
    ]),
    '只有主动关闭连接的一方在发送最后一个 ACK 后进入 TIME_WAIT 状态，等待时间为 2MSL（一来一回最大报文生存时间），既保障对端重传 FIN 时能再次响应 ACK，又防止历史迷途报文混入新连接。',
    '### 错误根因诊断\n容易将 **1MSL**（单程最大报文生存时间）与 **2MSL**（往返时间：最后 ACK 去程 + 对端重传 FIN 回程）混淆。\n\n### 记忆锚点\n记住「一去一回 = 2MSL，谁先主动说再见，谁就负责殿后等 2MSL」。',
    now,
    now,
    now
  );

  // Sample study activity logs over past 14 days for a vibrant heatmap
  for (let daysAgo = 0; daysAgo < 14; daysAgo++) {
    if (daysAgo % 3 === 2) continue;
    const d = new Date(Date.now() - daysAgo * 86400 * 1000);
    const dk = todayKey(d);
    const count = (daysAgo % 4) + 1;
    for (let k = 0; k < count; k++) {
      db.prepare(
        `INSERT INTO study_logs (id, activity_type, entity_id, duration_seconds, score, created_at, date_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uid(),
        k === 0 ? 'quiz_complete' : 'flashcard_review',
        note1Id,
        300,
        k === 0 ? Number((0.68 + (14 - daysAgo) * 0.02).toFixed(2)) : null,
        d.toISOString(),
        dk
      );
    }
  }

  return { notesCreated: sampleNotes.length, categoriesCreated: categories.length, flashcardsCreated: sampleCards.length };
}
