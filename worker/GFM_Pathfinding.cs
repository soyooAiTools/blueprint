// ============================================================
// GFM_Pathfinding.cs — A* 寻路算法
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using System.Collections.Generic;

public static class GFM_Pathfinding
{
    public static bool allowDiagonal = true;
    public static int maxSteps = 6000;

    public static List<Vector3> FindPath(GFM_Grid grid, Vector3 startPos, Vector3 endPos)
    {
        GFM_GridNode startNode = grid.GetNodeFromWorldPos(startPos);
        GFM_GridNode endNode = grid.GetNodeFromWorldPos(endPos);

        if (startNode == null || !startNode.walkable)
            startNode = grid.FindNearestWalkable(startPos);
        if (endNode == null || !endNode.walkable)
            endNode = grid.FindNearestWalkable(endPos);
        if (startNode == null || endNode == null) return null;

        for (int x = 0; x < grid.width; x++)
            for (int y = 0; y < grid.height; y++)
            {
                grid.nodes[x, y].gCost = 0;
                grid.nodes[x, y].hCost = 0;
                grid.nodes[x, y].parent = null;
            }

        List<GFM_GridNode> openList = new List<GFM_GridNode>();
        HashSet<GFM_GridNode> closedSet = new HashSet<GFM_GridNode>();
        openList.Add(startNode);

        int steps = 0;
        while (openList.Count > 0 && steps < maxSteps)
        {
            steps++;
            GFM_GridNode current = openList[0];
            for (int i = 1; i < openList.Count; i++)
            {
                if (openList[i].fCost < current.fCost ||
                    (openList[i].fCost == current.fCost && openList[i].hCost < current.hCost))
                    current = openList[i];
            }

            openList.Remove(current);
            closedSet.Add(current);

            if (current == endNode)
                return RetracePath(grid, startNode, endNode);

            List<GFM_GridNode> neighbors = grid.GetNeighbors(current, allowDiagonal);
            for (int i = 0; i < neighbors.Count; i++)
            {
                GFM_GridNode neighbor = neighbors[i];
                if (!neighbor.walkable || closedSet.Contains(neighbor)) continue;

                bool isDiag = (neighbor.row != current.row && neighbor.col != current.col);
                int moveCost = current.gCost + (isDiag ? 14 : 10);

                if (moveCost < neighbor.gCost || !openList.Contains(neighbor))
                {
                    neighbor.gCost = moveCost;
                    neighbor.hCost = GetHeuristic(neighbor, endNode);
                    neighbor.parent = current;
                    if (!openList.Contains(neighbor))
                        openList.Add(neighbor);
                }
            }
        }
        return null;
    }

    private static int GetHeuristic(GFM_GridNode a, GFM_GridNode b)
    {
        int dx = Mathf.Abs(a.row - b.row);
        int dz = Mathf.Abs(a.col - b.col);
        if (dx > dz) return 14 * dz + 10 * (dx - dz);
        return 14 * dx + 10 * (dz - dx);
    }

    private static List<Vector3> RetracePath(GFM_Grid grid, GFM_GridNode start, GFM_GridNode end)
    {
        List<Vector3> path = new List<Vector3>();
        GFM_GridNode current = end;
        while (current != start)
        {
            path.Add(grid.NodeToWorldPos(current));
            current = current.parent;
        }
        path.Add(grid.NodeToWorldPos(start));
        path.Reverse();
        return path;
    }

    public static Vector3 MoveAlongPath(List<Vector3> path, ref int pathIndex, Vector3 currentPos, float step)
    {
        if (path == null || pathIndex >= path.Count) return currentPos;
        Vector3 target = path[pathIndex];
        Vector3 newPos = Vector3.MoveTowards(currentPos, target, step);
        if (Vector3.Distance(newPos, target) < 0.01f)
            pathIndex++;
        return newPos;
    }

    public static List<Vector3> SimplifyPath(List<Vector3> path)
    {
        if (path == null || path.Count <= 2) return path;
        List<Vector3> simplified = new List<Vector3>();
        simplified.Add(path[0]);
        Vector3 lastDir = Vector3.zero;
        for (int i = 1; i < path.Count; i++)
        {
            Vector3 dir = (path[i] - path[i - 1]).normalized;
            if (dir != lastDir)
            {
                simplified.Add(path[i - 1]);
                lastDir = dir;
            }
        }
        simplified.Add(path[path.Count - 1]);
        return simplified;
    }
}
