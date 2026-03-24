#!/usr/bin/env python3.8
"""
Blueprint Python POC: 分镜解析 (parse-storyboard)
对比 Node.js curl 方案的稳定性和速度
"""
import os, sys, json, time

# Proxy for OpenAI
os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7890'
os.environ['HTTP_PROXY'] = 'http://127.0.0.1:7890'

from openai import OpenAI

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', 
    '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')

client = OpenAI(api_key=OPENAI_API_KEY, timeout=300)

SYSTEM_PROMPT = """你是分镜专家。解析 PDF 为 3 帧分镜。输出 JSON：{characterSheet:{角色名:外观描述}, frames:[{id, chapter, chapterTitle, step, prompt, title, scene, interaction, ui, timing, camera, animation, scriptExcerpt}]}。只输出 JSON。"""

def test_streaming():
    """Test 1: Streaming mode (recommended)"""
    print("=" * 60)
    print("Test 1: GPT-5.4 Streaming via Python openai SDK")
    print("=" * 60)
    
    pdf_path = '/opt/blueprint-editor/server-data/uploads/1774339435215_storyboard.pdf'
    
    # Upload file
    print("[1/3] Uploading PDF...")
    t0 = time.time()
    with open(pdf_path, 'rb') as f:
        uploaded = client.files.create(file=f, purpose='assistants')
    t_upload = time.time() - t0
    print(f"  ✅ Uploaded: {uploaded.id} in {t_upload:.1f}s")
    
    # Call GPT-5.4 with streaming
    print("[2/3] Calling GPT-5.4 (streaming)...")
    t1 = time.time()
    
    content_parts = [
        {"type": "file", "file": {"file_id": uploaded.id}},
        {"type": "text", "text": "请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。"}
    ]
    
    stream = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content_parts}
        ],
        max_completion_tokens=65536,
        temperature=0.3,
        stream=True,
    )
    
    full_content = ""
    finish_reason = ""
    chunk_count = 0
    
    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            full_content += delta.content
            chunk_count += 1
        if chunk.choices and chunk.choices[0].finish_reason:
            finish_reason = chunk.choices[0].finish_reason
    
    t_api = time.time() - t1
    
    print(f"  ✅ Response: {len(full_content)} chars, {chunk_count} chunks, finish={finish_reason} in {t_api:.1f}s")
    
    # Parse JSON
    print("[3/3] Parsing JSON...")
    try:
        # Clean markdown fences
        text = full_content.strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[1] if '\n' in text else text[3:]
        if text.endswith('```'):
            text = text[:-3]
        text = text.strip()
        
        data = json.loads(text)
        
        # Handle array wrapper
        if isinstance(data, list) and len(data) == 1 and 'frames' in data[0]:
            data = data[0]
        
        frames = data.get('frames', [])
        cs = data.get('characterSheet', {})
        
        print(f"  ✅ Parsed: {len(frames)} frames, {len(cs)} characters")
        for f in frames[:5]:
            print(f"    Frame {f.get('id')}: {f.get('title', '?')[:30]} - prompt:{len(f.get('prompt', ''))}c")
        
        # Save result
        out_path = '/tmp/python-poc-result.json'
        with open(out_path, 'w', encoding='utf-8') as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
        print(f"  Saved to {out_path}")
        
    except json.JSONDecodeError as e:
        print(f"  ❌ JSON parse failed: {e}")
        print(f"  First 200: {full_content[:200]}")
        print(f"  Last 200: {full_content[-200:]}")
    
    # Summary
    total = time.time() - t0
    print("\n" + "=" * 60)
    print(f"SUMMARY: upload={t_upload:.1f}s, api={t_api:.1f}s, total={total:.1f}s")
    print(f"  Content: {len(full_content)} chars, {chunk_count} chunks")
    print(f"  Finish: {finish_reason}")
    print(f"  Frames: {len(frames) if 'frames' in dir() else '?'}")
    print("=" * 60)


def test_non_streaming():
    """Test 2: Non-streaming (simpler but may timeout)"""
    print("\n" + "=" * 60)
    print("Test 2: GPT-5.4 Non-Streaming")
    print("=" * 60)
    
    t0 = time.time()
    resp = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": "Say 'Hello from Python' in exactly 5 words."},
            {"role": "user", "content": "Go."}
        ],
        max_completion_tokens=50,
        temperature=0.3,
    )
    t1 = time.time() - t0
    text = resp.choices[0].message.content
    print(f"  ✅ Non-streaming OK: '{text}' in {t1:.1f}s")
    print(f"  Finish: {resp.choices[0].finish_reason}")


if __name__ == '__main__':
    print(f"Python {sys.version}")
    print(f"openai SDK version: {__import__('openai').__version__}")
    print()
    
    # Quick connectivity test first
    test_non_streaming()
    
    # Full storyboard parse
    test_streaming()
