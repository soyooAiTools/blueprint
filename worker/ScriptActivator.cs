// ScriptActivator.cs — pre-baked behavior component for pool objects
// Attach to __Pool_* objects in Unity Editor. Activate at runtime via config.
using UnityEngine;

public class ScriptActivator : MonoBehaviour
{
    public string role = "";
    public string behavior = "";
    public float param1 = 0f;
    public float param2 = 0f;
    public float param3 = 0f;
    public Transform target;

    private bool _activated = false;
    private Vector3 _patrolOrigin;
    private float _timer = 0f;

    // 激活目标脚本或组件。
    public void Activate(string role, string behavior, float p1, float p2, float p3)
    {
        this.role = role;
        this.behavior = behavior;
        this.param1 = p1;
        this.param2 = p2;
        this.param3 = p3;
        _patrolOrigin = transform.position;
        _activated = true;
    }

    // 设置需要被激活控制的目标组件。
    public void SetTarget(Transform t) { target = t; }

    // 停用目标脚本或组件。
    public void Deactivate()
    {
        _activated = false;
        role = "";
        behavior = "";
    }

    // 返回当前目标是否处于激活状态。
    public bool IsActivated() { return _activated; }

    void Update()
    {
        if (!_activated) return;
        float dt = Time.deltaTime;

        switch (behavior)
        {
            case "patrol":
                _timer += dt * param1;
                float offset = Mathf.Sin(_timer) * param2;
                Vector3 patrolPos = _patrolOrigin;
                patrolPos.x += offset;
                transform.position = patrolPos;
                break;
            case "patrol_z":
                _timer += dt * param1;
                float zOffset = Mathf.Sin(_timer) * param2;
                Vector3 patrolZPos = _patrolOrigin;
                patrolZPos.z += zOffset;
                transform.position = patrolZPos;
                break;
            case "chase":
                if (target != null)
                {
                    transform.position = Vector3.MoveTowards(
                        transform.position, target.position,
                        param1 * dt);
                }
                break;
            case "rotate":
                transform.Rotate(0, param1 * dt, 0);
                break;
            case "bob":
                _timer += dt;
                Vector3 bobPos = transform.position;
                bobPos.y = _patrolOrigin.y + Mathf.Sin(_timer * param1) * param2;
                transform.position = bobPos;
                break;
            case "orbit":
                if (target != null)
                {
                    _timer += dt * param1;
                    float r = param2;
                    Vector3 orbitPos = transform.position;
                    orbitPos.x = target.position.x + Mathf.Cos(_timer) * r;
                    orbitPos.z = target.position.z + Mathf.Sin(_timer) * r;
                    transform.position = orbitPos;
                }
                break;
        }
    }
}
