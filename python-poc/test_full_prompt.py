#!/usr/bin/env python3.8
"""
Blueprint Python POC: 完整 system prompt 测试
验证 15 帧完整输出在 Python SDK 下无问题
"""
import os, sys, json, time

os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7890'
os.environ['HTTP_PROXY'] = 'http://127.0.0.1:7890'

from openai import OpenAI

OPENAI_API_KEY = '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'
client = OpenAI(api_key=OPENAI_API_KEY, timeout=600)

# Full system prompt from storyboard-parser.cjs (with defaults filled in)
SYSTEM_PROMPT = """你是一个资深试玩广告分镜专家。请根据需求拆分为**带章节的详细分镜**。

## 角色一致性（最重要！）
你必须在输出的第一帧之前，先定义一个 characterSheet 对象，描述主角和关键角色的固定外观特征（服装颜色、发型、体型、武器、标志性元素）。之后每一帧的 prompt 都必须引用这些角色描述，确保全部帧中角色外观完全一致。

## 输出格式
输出一个 JSON 对象，包含两个字段：
- characterSheet: 对象，key 为角色名，value 为英文外观描述（50-80词，固定不变）
- frames: 帧数组

每个大场景（章节）下拆 3-5 个子步骤，描述进入→操作→反馈→过渡的完整流程。

每帧输出 JSON 对象：
- id: 全局帧序号（从1开始，连续编号）
- chapter: 章节号（大场景编号）
- chapterTitle: 章节标题
- step: 章节内子步骤号
- prompt: 英文画面描述（给 AI 出图用）。**必须遵守以下规则：**
  - **角色描述**：每帧 prompt 开头必须引用 characterSheet 中的角色外观描述，逐字重复角色服装、发型、体型等关键特征，确保 AI 画出一致的角色形象
  - 视角：高空远景，使用 isometric 45-degree elevated camera angle，镜头拉高拉远，必须能看到整体地图/场景的全貌布局
  - 画面内容要极其详细（至少 150 英文单词）：
    * 精确描述每个角色的位置（用屏幕坐标如 center, top-left, bottom-right）、姿态、朝向、大小比例
    * 场景元素要全部列出：地形、建筑、道具、障碍物、装饰物的位置和状态，每个元素的大小、颜色、材质
    * 环境氛围：光源方向、色调、天气、时间段，雪花/烟雾/火光等粒子效果
  - UI overlay 标注必须包含：箭头方向和起止点、手指图标位置和手势类型（tap/drag/swipe）、高亮区域范围、按钮的文字和位置
- title: 中文标题（动词·结果 格式，如"拖动木材 · 点燃篝火"）
- scene: 中文场景描述（**至少 80 字**，对应"玩家看到什么"）
- interaction: 中文交互指引（**至少 100 字**）
- ui: 中文 UI 说明（**至少 80 字**）
- timing: 持续时间
- camera: 相机指令
- scriptExcerpt: 原脚本对应文案
- animation: 动画说明（**至少 60 字**）

要求：
1. 总帧数严格控制在 14 到 16 帧（目标 15 帧），绝对不能超出此范围
2. 根据总帧数目标合理分配每章节的子步骤数
3. 帧之间要有明确的叙事递进和过渡
4. prompt 中必须包含 UI 标注元素的描述
5. 适配横屏（手机横握）布局
6. **每帧描述必须极其详细**，interaction 至少 100 字，ui 至少 80 字，animation 至少 60 字
7. 视角统一使用 isometric 45-degree
8. **角色一致性是最高优先级**：每帧 prompt 必须重复角色外观描述

只输出 JSON，不要其他内容。"""


def main():
    pdf_path = '/opt/blueprint-editor/server-data/uploads/1774339435215_storyboard.pdf'
    
    print(f"System prompt: {len(SYSTEM_PROMPT)} chars")
    print(f"PDF: {os.path.getsize(pdf_path)} bytes")
    print()
    
    # Upload
    print("[1/3] Uploading PDF...")
    t0 = time.time()
    with open(pdf_path, 'rb') as f:
        uploaded = client.files.create(file=f, purpose='assistants')
    print(f"  ✅ {uploaded.id} in {time.time()-t0:.1f}s")
    
    # Stream
    print("[2/3] Calling GPT-5.4 (full prompt, streaming)...")
    t1 = time.time()
    
    stream = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "file", "file": {"file_id": uploaded.id}},
                {"type": "text", "text": "请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。"}
            ]}
        ],
        max_completion_tokens=65536,
        temperature=0.3,
        stream=True,
    )
    
    full = ""
    chunks = 0
    finish = ""
    last_print = time.time()
    
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
            chunks += 1
        if chunk.choices and chunk.choices[0].finish_reason:
            finish = chunk.choices[0].finish_reason
        # Progress every 30s
        if time.time() - last_print > 30:
            print(f"  ... {len(full)} chars, {chunks} chunks, {time.time()-t1:.0f}s elapsed")
            last_print = time.time()
    
    t_api = time.time() - t1
    print(f"  ✅ Done: {len(full)} chars, {chunks} chunks, finish={finish} in {t_api:.1f}s")
    
    # Save raw
    with open('/tmp/python-poc-full-raw.txt', 'w') as f:
        f.write(full)
    
    # Parse
    print("[3/3] Parsing JSON...")
    text = full.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()
    
    try:
        data = json.loads(text)
        if isinstance(data, list) and len(data) == 1 and 'frames' in data[0]:
            data = data[0]
        
        frames = data.get('frames', [])
        cs = data.get('characterSheet', {})
        
        print(f"  ✅ {len(frames)} frames, {len(cs)} characters")
        print(f"  Characters: {', '.join(cs.keys())}")
        for f in frames:
            prompt_len = len(f.get('prompt', ''))
            scene_len = len(f.get('scene', ''))
            inter_len = len(f.get('interaction', ''))
            print(f"    Frame {f.get('id'):2d}: {f.get('title', '?')[:25]:25s} prompt:{prompt_len:4d}c scene:{scene_len:3d}c interaction:{inter_len:3d}c")
        
        with open('/tmp/python-poc-full-result.json', 'w', encoding='utf-8') as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
        
    except json.JSONDecodeError as e:
        print(f"  ❌ JSON error: {e}")
        print(f"  finish_reason: {finish}")
        print(f"  Last 300: ...{text[-300:]}")
    
    total = time.time() - t0
    print(f"\n{'='*60}")
    print(f"TOTAL: {total:.1f}s (upload {time.time()-t0-t_api:.1f}s + api {t_api:.1f}s)")
    print(f"Output: {len(full)} chars, finish={finish}")
    print(f"{'='*60}")


if __name__ == '__main__':
    main()
