#!/usr/bin/env python3.8
"""
Blueprint V4 Converter - Doubao/OpenAI-compatible version
Converts storyboard frames → V4 entity-driven blueprint.
Usage: python3.8 blueprint_converter.py --frames-file <path> --schema-file <path> --templates-file <path>
Output: JSON to stdout, progress to stderr
"""
import os, sys, json, time, argparse, urllib.request, ssl

API_BASE = os.environ.get('DOUBAO_API_BASE', 'https://ark.cn-beijing.volces.com/api/v3').rstrip('/')
API_KEY = os.environ.get('DOUBAO_API_KEY') or os.environ.get('LLM_API_KEY', '')
MODEL = (
    os.environ.get('BLUEPRINT_V4_CONVERTER_MODEL')
    or os.environ.get('DOUBAO_TEXT_MODEL')
    or os.environ.get('LLM_MODEL_GENERATE')
    or 'doubao-seed-2-0-pro-260215'
)


def log(msg):
    print(f"[py-v4-convert] {msg}", file=sys.stderr, flush=True)


def convert_to_v4(system_prompt, user_prompt, max_tokens=65536):
    """Call an OpenAI-compatible text API for V4 conversion."""
    if not API_KEY:
        raise RuntimeError("DOUBAO_API_KEY is required for V4 conversion")
    url = f"{API_BASE}/chat/completions"
    log(f"Calling {MODEL} for V4 conversion (max_tokens={max_tokens})...")
    t0 = time.time()

    body = {
        "model": MODEL,
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    data = json.dumps(body).encode('utf-8')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
    }

    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        with urllib.request.urlopen(req, timeout=600, context=ctx) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        log(f"HTTP {e.code}: {error_body[:500]}")
        raise

    full = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    finish = result.get("choices", [{}])[0].get("finish_reason", "unknown")

    elapsed = time.time() - t0
    log(f"Done: {len(full)} chars, finish={finish} in {elapsed:.1f}s")
    return full, finish


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--frames-file', required=True)
    parser.add_argument('--schema-file', required=True)
    parser.add_argument('--templates-file', required=True)
    parser.add_argument('--max-tokens', type=int, default=65536)
    args = parser.parse_args()

    with open(args.frames_file, 'r', encoding='utf-8') as f:
        frames_data = json.load(f)
    with open(args.schema_file, 'r', encoding='utf-8') as f:
        v4_schema = f.read()
    with open(args.templates_file, 'r', encoding='utf-8') as f:
        templates = f.read()[:3000]

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

    user_prompt = f"请将以下分镜板转换为 V4 实体驱动蓝图：\n\n{frames_desc}\n\n返回纯 JSON（不要 markdown code fence）。"

    log(f"System prompt: {len(system_prompt)} chars, frames: {len(frames)}")

    raw, finish = convert_to_v4(system_prompt, user_prompt, args.max_tokens)

    # Parse JSON
    text = raw.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1]
    if text.endswith('```'):
        text = text[:-3]

    try:
        try:
            data = json.loads(text.strip())
        except:
            import re
            m = re.search(r'\{[\s\S]*\}', text)
            if m:
                data = json.loads(m.group())
            else:
                raise

        json.dump({"data": data, "meta": {"finish_reason": finish, "model": MODEL, "parser": "python-openai-compatible"}},
                  sys.stdout, ensure_ascii=False)
    except Exception as e:
        json.dump({"error": str(e), "finish_reason": finish, "raw_length": len(raw)},
                  sys.stdout, ensure_ascii=False)
        sys.exit(1)


if __name__ == '__main__':
    main()
