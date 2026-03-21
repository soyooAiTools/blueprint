// cc module type stub for Cocos Creator 3.x
// Provides type declarations so TypeScript compiles without the full engine

declare module 'cc' {
  // Decorators
  export const _decorator: {
    ccclass: (name?: string) => ClassDecorator;
    property: (options?: any) => PropertyDecorator;
    executeInEditMode: ClassDecorator;
    menu: (path: string) => ClassDecorator;
    disallowMultiple: ClassDecorator;
    requireComponent: (comp: any) => ClassDecorator;
  };

  // Core classes
  export class Component {
    node: Node;
    enabled: boolean;
    schedule(callback: Function, interval?: number, repeat?: number, delay?: number): void;
    unschedule(callback: Function): void;
    unscheduleAllCallbacks(): void;
    getComponent<T extends Component>(type: { new(): T } | string): T | null;
    getComponentInChildren<T extends Component>(type: { new(): T } | string): T | null;
    getComponents<T extends Component>(type: { new(): T } | string): T[];
    getComponentsInChildren<T extends Component>(type: { new(): T } | string): T[];
    onLoad?(): void;
    start?(): void;
    update?(dt: number): void;
    lateUpdate?(dt: number): void;
    onEnable?(): void;
    onDisable?(): void;
    onDestroy?(): void;
  }

  export class Node {
    name: string;
    active: boolean;
    parent: Node | null;
    children: Node[];
    position: Vec3;
    scale: Vec3;
    rotation: Quat;
    eulerAngles: Vec3;
    worldPosition: Vec3;
    worldScale: Vec3;
    worldRotation: Quat;
    getComponent<T extends Component>(type: { new(): T } | string): T | null;
    getComponentInChildren<T extends Component>(type: { new(): T } | string): T | null;
    getComponents<T extends Component>(type: { new(): T } | string): T[];
    getComponentsInChildren<T extends Component>(type: { new(): T } | string): T[];
    addComponent<T extends Component>(type: { new(): T } | string): T;
    removeComponent(comp: Component): void;
    addChild(child: Node): void;
    removeChild(child: Node): void;
    removeFromParent(): void;
    destroyAllChildren(): void;
    destroy(): boolean;
    setPosition(x: number | Vec3, y?: number, z?: number): void;
    setScale(x: number | Vec3, y?: number, z?: number): void;
    setRotation(x: number | Quat, y?: number, z?: number, w?: number): void;
    setWorldPosition(x: number | Vec3, y?: number, z?: number): void;
    lookAt(pos: Vec3, up?: Vec3): void;
    on(type: string, callback: Function, target?: any): void;
    off(type: string, callback?: Function, target?: any): void;
    emit(type: string, ...args: any[]): void;
    setParent(parent: Node | null): void;
    walk(preFunc: (target: Node) => void, postFunc?: (target: Node) => void): void;
    getChildByName(name: string): Node | null;
    getChildByPath(path: string): Node | null;
    setSiblingIndex(index: number): void;
    isChildOf(parent: Node): boolean;
  }

  // Math
  export class Vec2 {
    x: number; y: number;
    constructor(x?: number, y?: number);
    static ZERO: Vec2;
    clone(): Vec2;
    set(x: number, y?: number): Vec2;
    add(other: Vec2): Vec2;
    subtract(other: Vec2): Vec2;
    multiplyScalar(num: number): Vec2;
    length(): number;
    normalize(): Vec2;
    static distance(a: Vec2, b: Vec2): number;
    static lerp<Out extends Vec2>(out: Out, a: Vec2, b: Vec2, t: number): Out;
  }

  export class Vec3 {
    x: number; y: number; z: number;
    constructor(x?: number, y?: number, z?: number);
    static ZERO: Vec3;
    static UP: Vec3;
    static RIGHT: Vec3;
    static FORWARD: Vec3;
    static ONE: Vec3;
    clone(): Vec3;
    set(x: number, y?: number, z?: number): Vec3;
    add(other: Vec3): Vec3;
    subtract(other: Vec3): Vec3;
    multiplyScalar(num: number): Vec3;
    length(): number;
    normalize(): Vec3;
    negative(): Vec3;
    dot(other: Vec3): number;
    cross(other: Vec3): Vec3;
    static distance(a: Vec3, b: Vec3): number;
    static lerp<Out extends Vec3>(out: Out, a: Vec3, b: Vec3, t: number): Out;
    static add<Out extends Vec3>(out: Out, a: Vec3, b: Vec3): Out;
    static subtract<Out extends Vec3>(out: Out, a: Vec3, b: Vec3): Out;
    static transformMat4<Out extends Vec3>(out: Out, a: Vec3, mat: Mat4): Out;
    equals(other: Vec3): boolean;
  }

  export class Vec4 {
    x: number; y: number; z: number; w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
  }

  export class Quat {
    x: number; y: number; z: number; w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
    static fromEuler<Out extends Quat>(out: Out, x: number, y: number, z: number): Out;
    static toEuler(out: Vec3, q: Quat): Vec3;
    static slerp<Out extends Quat>(out: Out, a: Quat, b: Quat, t: number): Out;
  }

  export class Mat4 {
    constructor();
    static identity<Out extends Mat4>(out: Out): Out;
  }

  export class Color {
    r: number; g: number; b: number; a: number;
    constructor(r?: number, g?: number, b?: number, a?: number);
    static WHITE: Color;
    static BLACK: Color;
    static RED: Color;
    static GREEN: Color;
    static BLUE: Color;
    clone(): Color;
  }

  export class Size {
    width: number; height: number;
    constructor(width?: number, height?: number);
  }

  export class Rect {
    x: number; y: number; width: number; height: number;
    constructor(x?: number, y?: number, width?: number, height?: number);
    contains(point: Vec2): boolean;
  }

  // Property types
  export const CCFloat: any;
  export const CCInteger: any;
  export const CCBoolean: any;
  export const CCString: any;
  export function ccenum(e: any): void;
  export function cctype(type: any): PropertyDecorator;

  // UI
  export class Label extends Component {
    string: string;
    fontSize: number;
    color: Color;
  }
  export class Sprite extends Component {
    spriteFrame: SpriteFrame | null;
    color: Color;
    type: number;
    sizeMode: number;
  }
  export class Button extends Component {}
  export class Layout extends Component {}
  export class ScrollView extends Component {}
  export class EditBox extends Component {}
  export class ProgressBar extends Component {}
  export class Slider extends Component {}
  export class Toggle extends Component {}
  export class RichText extends Component {}
  export class Widget extends Component {}
  export class Canvas extends Component {}
  export class UITransform extends Component {
    contentSize: Size;
    anchorPoint: Vec2;
    setContentSize(size: Size | number, height?: number): void;
    setAnchorPoint(point: Vec2 | number, y?: number): void;
    convertToNodeSpaceAR(worldPoint: Vec3, out?: Vec3): Vec3;
    convertToWorldSpaceAR(nodePoint: Vec3, out?: Vec3): Vec3;
    getBoundingBox(): Rect;
    getBoundingBoxToWorld(): Rect;
  }
  export class UIOpacity extends Component {
    opacity: number;
  }
  export class BlockInputEvents extends Component {}
  export class Mask extends Component {}
  export class Graphics extends Component {}

  // 3D
  export class MeshRenderer extends Component {
    mesh: any;
    material: Material | null;
    materials: (Material | null)[];
    setMaterial(material: Material | null, index: number): void;
  }
  export class Camera extends Component {
    orthoHeight: number;
    fov: number;
    near: number;
    far: number;
    clearColor: Color;
    priority: number;
    visibility: number;
  }
  export class DirectionalLight extends Component {}
  export class PointLight extends Component {}
  export class SpotLight extends Component {}

  // Animation
  export class Animation extends Component {
    play(name?: string): void;
    stop(): void;
    pause(): void;
    resume(): void;
    getState(name: string): any;
    on(type: string, callback: Function, target?: any): void;
  }
  export class AnimationClip {}
  export class SkeletalAnimation extends Component {}
  export class SkinnedMeshRenderer extends MeshRenderer {}

  // Physics
  export class RigidBody extends Component {}
  export class BoxCollider extends Component {}
  export class SphereCollider extends Component {}
  export class CapsuleCollider extends Component {}
  export class MeshCollider extends Component {}

  // Audio
  export class AudioSource extends Component {
    clip: AudioClip | null;
    volume: number;
    loop: boolean;
    play(): void;
    stop(): void;
    pause(): void;
    resume(): void;
    playOneShot(clip: AudioClip, volume?: number): void;
  }
  export class AudioClip {}

  // Assets
  export class Asset { name: string; }
  export class Prefab extends Asset {}
  export class SpriteFrame extends Asset {}
  export class Texture2D extends Asset {}
  export class Material extends Asset {
    setProperty(name: string, val: any): void;
    getProperty(name: string): any;
  }
  export class TextAsset extends Asset { text: string; }
  export class JsonAsset extends Asset { json: any; }
  export class ImageAsset extends Asset {}
  export class Font extends Asset {}
  export class Mesh extends Asset {}
  export class EffectAsset extends Asset {}
  export class RenderTexture extends Asset {}
  export class SpriteAtlas extends Asset {}
  export class VideoClip extends Asset {}

  // Particle
  export class ParticleSystem extends Component {}

  // Tween
  export function tween<T>(target?: T): Tween<T>;
  export class Tween<T> {
    to(duration: number, props: any, opts?: any): Tween<T>;
    by(duration: number, props: any, opts?: any): Tween<T>;
    delay(duration: number): Tween<T>;
    call(callback: Function): Tween<T>;
    sequence(...actions: Tween<T>[]): Tween<T>;
    parallel(...actions: Tween<T>[]): Tween<T>;
    repeat(times: number, action?: Tween<T>): Tween<T>;
    repeatForever(action?: Tween<T>): Tween<T>;
    start(): Tween<T>;
    stop(): Tween<T>;
    union(): Tween<T>;
    target(target: T): Tween<T>;
  }

  // System
  export const director: {
    getScene(): any;
    loadScene(name: string, callback?: Function): void;
  };
  export const view: {
    getVisibleSize(): Size;
    getDesignResolutionSize(): Size;
  };
  export const screen: {
    windowSize: Size;
  };
  export const sys: {
    platform: number;
    isMobile: boolean;
    isBrowser: boolean;
    isNative: boolean;
    localStorage: Storage;
  };

  // Resources
  export const resources: {
    load<T extends Asset>(path: string, type: { new(): T }, callback: (err: Error | null, asset: T) => void): void;
    load<T extends Asset>(path: string, callback: (err: Error | null, asset: T) => void): void;
    loadDir<T extends Asset>(path: string, type: { new(): T }, callback: (err: Error | null, assets: T[]) => void): void;
    preload(path: string, type?: any, callback?: Function): void;
  };
  export const assetManager: {
    loadRemote<T extends Asset>(url: string, callback: (err: Error | null, asset: T) => void): void;
    loadBundle(name: string, callback: (err: Error | null, bundle: any) => void): void;
  };

  // Input
  export const input: {
    on(type: string, callback: Function, target?: any): void;
    off(type: string, callback?: Function, target?: any): void;
  };
  export enum Input {
    EventType = 0
  }
  export namespace Input {
    enum EventType {
      MOUSE_DOWN = 'mouse-down',
      MOUSE_UP = 'mouse-up',
      MOUSE_MOVE = 'mouse-move',
      MOUSE_WHEEL = 'mouse-wheel',
      TOUCH_START = 'touch-start',
      TOUCH_MOVE = 'touch-move',
      TOUCH_END = 'touch-end',
      TOUCH_CANCEL = 'touch-cancel',
      KEY_DOWN = 'key-down',
      KEY_UP = 'key-up',
    }
  }

  export class EventTouch {
    getLocation(): Vec2;
    getUILocation(): Vec2;
    getDelta(): Vec2;
    touch: any;
    getID(): number;
  }
  export class EventMouse {
    getLocation(): Vec2;
    getDelta(): Vec2;
    getScrollY(): number;
    getButton(): number;
  }
  export class EventKeyboard {
    keyCode: number;
  }
  export enum KeyCode {
    SPACE = 32,
    ENTER = 13,
    ESCAPE = 27,
  }

  // Misc
  export function instantiate(prefab: Prefab | Node): Node;
  export function find(path: string, referenceNode?: Node): Node | null;
  export function isValid(value: any, strictMode?: boolean): boolean;
  export const game: {
    frameRate: number;
    totalTime: number;
    deltaTime: number;
    on(type: string, callback: Function, target?: any): void;
    addPersistRootNode(node: Node): void;
    removePersistRootNode(node: Node): void;
  };
  export function log(...args: any[]): void;
  export function warn(...args: any[]): void;
  export function error(...args: any[]): void;

  // Geometry / Raycast
  export namespace geometry {
    class Ray {
      static create(ox?: number, oy?: number, oz?: number, dx?: number, dy?: number, dz?: number): Ray;
    }
    function intersect(a: any, b: any): number;
  }

  // Physics raycast
  export class PhysicsSystem {
    static get instance(): PhysicsSystem;
    raycast(ray: any): boolean;
    raycastResults: any[];
    raycastClosestResult: any;
  }

  // Collider events
  export class Collider extends Component {
    on(type: string, callback: Function, target?: any): void;
  }
  export interface ICollisionEvent {
    contacts: any[];
    otherCollider: Collider;
    selfCollider: Collider;
  }
  export interface ITriggerEvent {
    otherCollider: Collider;
    selfCollider: Collider;
  }

  // Enum
  export enum macro {
    KEY = 0,
  }

  // Legacy compatibility
  export const _cclegacy: any;
  export function __checkObsolete__(args: string[]): void;
  export function __checkObsoleteInNamespace__(args: string[]): void;
}
