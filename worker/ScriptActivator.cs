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

    public void SetTarget(Transform t) { target = t; }

    public void Deactivate()
    {
        _activated = false;
        role = "";
        behavior = "";
    }

    public bool IsActivated() { return _activated; }

    void Update()
    {
        if (!_activated) return;
        float dt = Time.deltaTime;

        if (behavior == "patrol")
        {
            _timer += dt * param1;
            float offset = Mathf.Sin(_timer) * param2;
            transform.position = _patrolOrigin + new Vector3(offset, 0, 0);
        }
        else if (behavior == "patrol_z")
        {
            _timer += dt * param1;
            float offset = Mathf.Sin(_timer) * param2;
            transform.position = _patrolOrigin + new Vector3(0, 0, offset);
        }
        else if (behavior == "chase")
        {
            if (target != null)
            {
                transform.position = Vector3.MoveTowards(
                    transform.position, target.position,
                    param1 * dt);
            }
        }
        else if (behavior == "rotate")
        {
            transform.Rotate(0, param1 * dt, 0);
        }
        else if (behavior == "bob")
        {
            _timer += dt;
            float y = _patrolOrigin.y + Mathf.Sin(_timer * param1) * param2;
            transform.position = new Vector3(transform.position.x, y, transform.position.z);
        }
        else if (behavior == "orbit")
        {
            if (target != null)
            {
                _timer += dt * param1;
                float r = param2;
                float ox = target.position.x + Mathf.Cos(_timer) * r;
                float oz = target.position.z + Mathf.Sin(_timer) * r;
                transform.position = new Vector3(ox, transform.position.y, oz);
            }
        }
    }
}
