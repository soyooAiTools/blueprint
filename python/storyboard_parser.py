#!/usr/bin/env python3.8
"""
Blueprint Storyboard Parser - Python version
Usage: python3.8 storyboard_parser.py --pdf <path> --system-prompt <path> --user-text <text> [--file-ids id1,id2] [--max-tokens 65536]
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
    """Log to stderr so stdout stays clean for JSON output"""
    print(f"[py-storyboard] {msg}", file=sys.stderr, flush=True)


def upload_pdf(pdf_path):
    """Upload PDF to OpenAI Files API"""
    log(f"Uploading PDF ({os.path.getsize(pdf_path)} bytes)...")
    t0 = time.time()
    with open(pdf_path, 'rb') as f:
        uploaded = client.files.create(file=f, purpose='assistants')
    log(f"Uploaded: {uploaded.id} in {time.time()-t0:.1f}s")
    return uploaded.id


def parse_storyboard(system_prompt, user_content, max_tokens=65536):
    """Call GPT-5.4 with streaming, return parsed content"""
    log(f"Calling GPT-5.4 (streaming, max_tokens={max_tokens})...")
    t0 = time.time()
    
    stream = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        max_completion_tokens=max_tokens,
        temperature=0.3,
        stream=True,
    )
    
    full = ""
    chunks = 0
    finish = ""
    last_log = time.time()
    
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
            chunks += 1
        if chunk.choices and chunk.choices[0].finish_reason:
            finish = chunk.choices[0].finish_reason
        if time.time() - last_log > 30:
            log(f"  progress: {len(full)} chars, {chunks} chunks, {time.time()-t0:.0f}s")
            last_log = time.time()
    
    elapsed = time.time() - t0
    log(f"Done: {len(full)} chars, {chunks} chunks, finish={finish} in {elapsed:.1f}s")
    
    return full, finish


def extract_json(text):
    """Extract and parse JSON from GPT output"""
    text = text.strip()
    # Remove markdown fences
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()
    
    # Try direct parse
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object or array
        start = min(
            (text.find(c) for c in '{[' if text.find(c) >= 0),
            default=-1
        )
        if start < 0:
            raise ValueError(f"No JSON found in {len(text)} chars of output")
        
        # Find matching end
        if text[start] == '{':
            end = text.rfind('}')
        else:
            end = text.rfind(']')
        
        if end <= start:
            raise ValueError("Incomplete JSON")
        
        data = json.loads(text[start:end+1])
    
    # Handle array wrapper: [{characterSheet, frames}] -> {characterSheet, frames}
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) and 'frames' in data[0]:
        log("Unwrapped single-element array wrapper")
        data = data[0]
    
    return data


def main():
    parser = argparse.ArgumentParser(description='Blueprint Storyboard Parser')
    parser.add_argument('--pdf', help='Path to PDF file to upload and parse')
    parser.add_argument('--file-id', help='Already-uploaded OpenAI file ID (skip upload)')
    parser.add_argument('--system-prompt-file', help='Path to file containing system prompt')
    parser.add_argument('--system-prompt', help='System prompt string (use file for long prompts)')
    parser.add_argument('--user-text', default='请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。',
                        help='User message text')
    parser.add_argument('--extra-text', default='', help='Additional context text')
    parser.add_argument('--max-tokens', type=int, default=65536)
    parser.add_argument('--raw-output', help='Save raw GPT output to this file')
    args = parser.parse_args()
    
    # Get system prompt
    if args.system_prompt_file:
        with open(args.system_prompt_file, 'r', encoding='utf-8') as f:
            system_prompt = f.read()
    elif args.system_prompt:
        system_prompt = args.system_prompt
    else:
        log("ERROR: --system-prompt or --system-prompt-file required")
        sys.exit(1)
    
    log(f"System prompt: {len(system_prompt)} chars")
    
    # Get file_id
    file_id = args.file_id
    if not file_id and args.pdf:
        file_id = upload_pdf(args.pdf)
    
    # Build user content
    user_content = []
    if file_id:
        user_content.append({"type": "file", "file": {"file_id": file_id}})
    
    text = args.user_text
    if args.extra_text:
        text += f"\n\n补充说明：{args.extra_text}"
    user_content.append({"type": "text", "text": text})
    
    # Call GPT-5.4
    raw_text, finish_reason = parse_storyboard(system_prompt, user_content, args.max_tokens)
    
    # Save raw output if requested
    if args.raw_output:
        with open(args.raw_output, 'w', encoding='utf-8') as f:
            f.write(raw_text)
        log(f"Raw output saved to {args.raw_output}")
    
    # Parse JSON
    try:
        data = extract_json(raw_text)
    except (json.JSONDecodeError, ValueError) as e:
        # Return error as JSON
        json.dump({
            "error": str(e),
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "raw_tail": raw_text[-500:] if raw_text else ""
        }, sys.stdout, ensure_ascii=False)
        sys.exit(1)
    
    # Add metadata
    result = {
        "data": data,
        "meta": {
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "model": "gpt-5.4",
            "parser": "python"
        }
    }
    
    # Output JSON to stdout
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.exit(0)


if __name__ == '__main__':
    main()
