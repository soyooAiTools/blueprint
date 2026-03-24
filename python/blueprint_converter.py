#!/usr/bin/env python3.8
"""
Blueprint V4 Converter - Python version
Usage: python3.8 blueprint_converter.py --frames-file <path> --schema-file <path> --templates-file <path>
Output: JSON to stdout
"""
import os, sys, json, time, argparse

os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7890'
os.environ['HTTP_PROXY'] = 'http://127.0.0.1:7890'

from openai import OpenAI

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY',
    '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')

client = OpenAI(api_key=OPENAI_API_KEY, timeout=600)


def log(msg):
    print(f"[py-v4-convert] {msg}", file=sys.stderr, flush=True)


def convert_to_v4(system_prompt, frames_desc, max_tokens=65536):
    """Call GPT-5.4 to convert frames to V4 blueprint"""
    log(f"Calling GPT-5.4 for V4 conversion (streaming)...")
    t0 = time.time()
    
    stream = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"请将以下分镜板转换为 V4 实体驱动蓝图：\n\n{frames_desc}\n\n返回纯 JSON（不要 markdown code fence）。"}
        ],
        max_completion_tokens=max_tokens,
        temperature=0.3,
        stream=True,
    )
    
    full = ""
    finish = ""
    last_log = time.time()
    
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
        if chunk.choices and chunk.choices[0].finish_reason:
            finish = chunk.choices[0].finish_reason
        if time.time() - last_log > 30:
            log(f"  progress: {len(full)} chars, {time.time()-t0:.0f}s")
            last_log = time.time()
    
    log(f"Done: {len(full)} chars, finish={finish} in {time.time()-t0:.1f}s")
    return full, finish


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--frames-file', required=True, help='JSON file with frames data')
    parser.add_argument('--schema-file', required=True, help='V4 schema JSON file')
    parser.add_argument('--templates-file', required=True, help='Behavior templates MD file')
    parser.add_argument('--max-tokens', type=int, default=65536)
    args = parser.parse_args()
    
    with open(args.frames_file, 'r', encoding='utf-8') as f:
        frames_data = json.load(f)
    with open(args.schema_file, 'r', encoding='utf-8') as f:
        v4_schema = f.read()
    with open(args.templates_file, 'r', encoding='utf-8') as f:
        templates = f.read()[:3000]
    
    # Build frames description
    frames = frames_data if isinstance(frames_data, list) else frames_data.get('frames', [])
    frames_desc = "\n---\n".join(
        f"Frame {fr.get('id')}: {fr.get('title', '')}\nScene: {fr.get('scene', '')}\nInteraction: {fr.get('interaction', '')}"
        for fr in frames
    )
    
    system_prompt = f"""你是试玩广告蓝图架构师。你的任务是将分镜板（storyboard frames）转换为 V4 实体驱动蓝图。

## 核心原则
- **非线性**：不要按时间线顺序映射，而是提取所有游戏实体和它们的事件触发关系
- **实体为中心**：每个游戏对象都是独立实体
- **条件驱动**：Phase 只管"激活哪些实体"和"结束条件"

## V4 数据 Schema
{v4_schema}

## 行为模板参考
{templates}

## 输出要求
返回纯 JSON，包含:
1. entities: 所有游戏实体数组
2. phases: 阶段数组
3. globalSettings: 游戏全局设置

确保每个实体有唯一英文 name 和中文 label。"""

    log(f"System prompt: {len(system_prompt)} chars, frames: {len(frames)}")
    
    raw, finish = convert_to_v4(system_prompt, frames_desc, args.max_tokens)
    
    # Parse
    text = raw.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1]
    if text.endswith('```'):
        text = text[:-3]
    
    try:
        match = None
        try:
            data = json.loads(text.strip())
        except:
            import re
            m = re.search(r'\{[\s\S]*\}', text)
            if m:
                data = json.loads(m.group())
            else:
                raise
        
        json.dump({"data": data, "meta": {"finish_reason": finish, "model": "gpt-5.4", "parser": "python"}},
                  sys.stdout, ensure_ascii=False)
    except Exception as e:
        json.dump({"error": str(e), "finish_reason": finish, "raw_length": len(raw)},
                  sys.stdout, ensure_ascii=False)
        sys.exit(1)


if __name__ == '__main__':
    main()
