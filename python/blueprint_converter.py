#!/usr/bin/env python3.8
"""
Blueprint V4 Converter - Claude Opus 4.6 version
Converts storyboard frames → V4 entity-driven blueprint.
Replaces GPT-5.4 with Claude Opus 4.6 via Anthropic relay.
Usage: python3.8 blueprint_converter.py --frames-file <path> --schema-file <path> --templates-file <path>
Output: JSON to stdout, progress to stderr
"""
import os, sys, json, time, argparse, urllib.request, ssl

os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)
os.environ.pop('https_proxy', None)
os.environ.pop('http_proxy', None)

API_BASE = os.environ.get('ANTHROPIC_BASE_URL', 'https://crs.mindrix.app/api/anthropic')
API_KEY = os.environ.get('LLM_API_KEY', 'oki-d82fb9cf928492b23847db9569dd1f912906cc09135c62fe20b5fa3f0576')
MODEL = os.environ.get('LLM_MODEL_GENERATE', 'claude-opus-4-6')


def log(msg):
    print(f"[py-v4-convert] {msg}", file=sys.stderr, flush=True)


def convert_to_v4(system_prompt, user_prompt, max_tokens=65536):
    """Call Claude Opus 4.6 via Anthropic API for V4 conversion"""
    url = f"{API_BASE}/v1/messages"
    log(f"Calling Claude {MODEL} for V4 conversion (max_tokens={max_tokens})...")
    t0 = time.time()

    body = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "stream": True,
    }

    data = json.dumps(body).encode('utf-8')
    headers = {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
    }

    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    full = ""
    finish = "unknown"
    last_progress = time.time()

    try:
        with urllib.request.urlopen(req, timeout=600, context=ctx) as resp:
            # SSE streaming
            for raw_line in resp:
                line = raw_line.decode('utf-8', errors='replace').strip()
                if not line or not line.startswith('data: '):
                    continue
                payload = line[6:]
                if payload == '[DONE]':
                    break
                try:
                    event = json.loads(payload)
                except:
                    continue

                event_type = event.get('type', '')
                if event_type == 'content_block_delta':
                    delta = event.get('delta', {})
                    if delta.get('type') == 'text_delta':
                        full += delta.get('text', '')
                elif event_type == 'message_delta':
                    finish = event.get('delta', {}).get('stop_reason', finish)

                # Progress reporting every 3s
                if time.time() - last_progress > 3:
                    elapsed = time.time() - t0
                    log(f"  progress: {len(full)} chars, {elapsed:.0f}s")
                    print(f"PROGRESS:{len(full)}:{elapsed:.0f}", file=sys.stderr, flush=True)
                    last_progress = time.time()

    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        log(f"HTTP {e.code}: {error_body[:500]}")
        # Fallback: try non-streaming
        log("Retrying without streaming...")
        body["stream"] = False
        data = json.dumps(body).encode('utf-8')
        req2 = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req2, timeout=600, context=ctx) as resp2:
            result = json.loads(resp2.read().decode('utf-8'))
        for block in result.get("content", []):
            if block.get("type") == "text":
                full += block["text"]
        finish = result.get("stop_reason", "unknown")

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

        json.dump({"data": data, "meta": {"finish_reason": finish, "model": MODEL, "parser": "python-claude"}},
                  sys.stdout, ensure_ascii=False)
    except Exception as e:
        json.dump({"error": str(e), "finish_reason": finish, "raw_length": len(raw)},
                  sys.stdout, ensure_ascii=False)
        sys.exit(1)


if __name__ == '__main__':
    main()
