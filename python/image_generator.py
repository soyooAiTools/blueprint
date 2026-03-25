#!/usr/bin/env python3.8
"""
Blueprint Image Generator with frame-to-frame consistency.
- Frame 1: images.generate (establish base scene)
- Frame 2+: images.edit (pass previous frame as reference, maintain consistency)
Usage: python3.8 image_generator.py --prompt <text_or_file> --size 1536x1024 [--prev-image <path>] --output <path>
"""
import os, sys, json, time, argparse, base64

os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)

from openai import OpenAI

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY',
    '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')

client = OpenAI(api_key=OPENAI_API_KEY, base_url=os.environ.get('OPENAI_BASE_URL', 'https://sub.mindrix.app/v1'), timeout=180)


def log(msg):
    print(f"[py-imagegen] {msg}", file=sys.stderr, flush=True)


def generate_first_frame(prompt, size="1536x1024", quality="medium"):
    """Generate the first frame from scratch"""
    log(f"Generating frame 1 (generate, {quality}, {size})...")
    t0 = time.time()
    resp = client.images.generate(
        model="gpt-image-1",
        prompt=prompt[:4000],
        size=size,
        quality=quality,
        n=1,
    )
    elapsed = time.time() - t0
    b64 = resp.data[0].b64_json
    log(f"Frame 1 done: {len(b64)} b64 chars in {elapsed:.1f}s")
    return b64


def generate_consistent_frame(prompt, prev_image_path, size="1536x1024", quality="medium"):
    """Generate subsequent frame using previous frame as reference via edit API"""
    log(f"Generating frame (edit mode, ref: {os.path.basename(prev_image_path)})...")
    t0 = time.time()
    
    # Strategy: Use images.edit with the previous frame as base image
    # The prompt instructs to keep the same scene layout but update specific elements
    consistency_prefix = (
        "IMPORTANT: Keep the EXACT SAME scene layout, ground texture, building positions, "
        "color palette, art style, and camera angle as the reference image. "
        "Only change the specific elements described below. "
        "Maintain identical: ground/terrain pattern, building architecture style, "
        "tree positions, sky color, lighting direction, UI style. "
        "Changes for this frame: "
    )
    
    edit_prompt = consistency_prefix + prompt[:3500]
    
    with open(prev_image_path, 'rb') as img_file:
        resp = client.images.edit(
            model="gpt-image-1",
            image=img_file,
            prompt=edit_prompt,
            size=size,
        )
    
    elapsed = time.time() - t0
    b64 = resp.data[0].b64_json
    log(f"Frame done: {len(b64)} b64 chars in {elapsed:.1f}s")
    return b64


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompt', help='Prompt text or path to prompt file')
    parser.add_argument('--prompt-file', help='Path to file containing prompt')
    parser.add_argument('--prev-image', help='Path to previous frame image (for consistency)')
    parser.add_argument('--size', default='1536x1024')
    parser.add_argument('--quality', default='medium', choices=['low', 'medium', 'high'])
    parser.add_argument('--output', required=True, help='Output path for generated image')
    args = parser.parse_args()
    
    # Get prompt
    if args.prompt_file:
        with open(args.prompt_file, 'r', encoding='utf-8') as f:
            prompt = f.read()
    elif args.prompt:
        prompt = args.prompt
    else:
        log("ERROR: --prompt or --prompt-file required")
        sys.exit(1)
    
    log(f"Prompt: {len(prompt)} chars, prev_image: {args.prev_image or 'none'}")
    
    try:
        if args.prev_image and os.path.exists(args.prev_image):
            # Subsequent frame: use edit for consistency
            b64 = generate_consistent_frame(prompt, args.prev_image, args.size, args.quality)
        else:
            # First frame: generate from scratch
            b64 = generate_first_frame(prompt, args.size, args.quality)
        
        # Save image
        img_data = base64.b64decode(b64)
        with open(args.output, 'wb') as f:
            f.write(img_data)
        
        # Output result as JSON to stdout
        json.dump({
            "success": True,
            "output": args.output,
            "size": len(img_data),
            "mode": "edit" if args.prev_image else "generate"
        }, sys.stdout)
        
    except Exception as e:
        log(f"ERROR: {e}")
        json.dump({
            "success": False,
            "error": str(e)[:500]
        }, sys.stdout)
        sys.exit(1)


if __name__ == '__main__':
    main()
