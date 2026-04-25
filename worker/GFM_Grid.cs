// ============================================================
// GFM_Grid.cs — A* 寻路网格 + 网格节点
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using System.Collections.Generic;

public class GFM_GridNode
{
    public int row;
    public int col;
    public float worldX;
    public float worldZ;
    public bool walkable;
    public int gCost;
    public int hCost;
    public int fCost { get { return gCost + hCost; } }
    public GFM_GridNode parent;

    public GFM_GridNode(int row, int col, float worldX, float worldZ, bool walkable)
    {
        this.row = row;
        this.col = col;
        this.worldX = worldX;
        this.worldZ = worldZ;
        this.walkable = walkable;
    }
}

public class GFM_Grid
{
    public int width;
    public int height;
    public float cellSize;
    public Vector3 origin;
    public GFM_GridNode[,] nodes;

    public GFM_Grid(int width, int height, float cellSize, Vector3 origin)
    {
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.origin = origin;
        nodes = new GFM_GridNode[width, height];
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                float wx = origin.x + x * cellSize + cellSize * 0.5f;
                float wz = origin.z + y * cellSize + cellSize * 0.5f;
                nodes[x, y] = new GFM_GridNode(x, y, wx, wz, true);
            }
        }
    }

    // 设置指定网格节点是否可通行。
    public void SetWalkable(int x, int y, bool walkable)
    {
        if (x >= 0 && x < width && y >= 0 && y < height)
            nodes[x, y].walkable = walkable;
    }

    // 批量设置矩形区域内的网格可通行状态。
    public void SetWalkableRect(int xMin, int yMin, int xMax, int yMax, bool walkable)
    {
        for (int x = Mathf.Max(0, xMin); x <= Mathf.Min(width - 1, xMax); x++)
            for (int y = Mathf.Max(0, yMin); y <= Mathf.Min(height - 1, yMax); y++)
                nodes[x, y].walkable = walkable;
    }

    // 按世界坐标设置所在网格节点可通行状态。
    public void SetWalkableByWorldPos(Vector3 worldPos, bool walkable)
    {
        GFM_GridNode node = GetNodeFromWorldPos(worldPos);
        if (node != null) node.walkable = walkable;
    }

    // 根据场景碰撞体检测障碍并更新网格。
    public void DetectObstacles(LayerMask obstacleLayer, float checkHeight)
    {
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                Vector3 worldPos = new Vector3(nodes[x, y].worldX, checkHeight, nodes[x, y].worldZ);
                if (Physics.Raycast(worldPos, Vector3.down, checkHeight + 1f, obstacleLayer))
                    nodes[x, y].walkable = false;
            }
        }
    }

    // 把世界坐标转换为网格节点。
    public GFM_GridNode GetNodeFromWorldPos(Vector3 worldPos)
    {
        int x = Mathf.FloorToInt((worldPos.x - origin.x) / cellSize);
        int z = Mathf.FloorToInt((worldPos.z - origin.z) / cellSize);
        if (x < 0 || x >= width || z < 0 || z >= height) return null;
        return nodes[x, z];
    }

    // 把网格节点转换回世界坐标。
    public Vector3 NodeToWorldPos(GFM_GridNode node)
    {
        return new Vector3(node.worldX, origin.y, node.worldZ);
    }

    // 获取指定节点周围可用于寻路的邻居节点。
    public List<GFM_GridNode> GetNeighbors(GFM_GridNode node, bool allowDiagonal)
    {
        List<GFM_GridNode> neighbors = new List<GFM_GridNode>();
        int[] dx = { 0, 0, -1, 1 };
        int[] dz = { -1, 1, 0, 0 };
        for (int i = 0; i < 4; i++)
        {
            int nx = node.row + dx[i];
            int nz = node.col + dz[i];
            if (nx >= 0 && nx < width && nz >= 0 && nz < height)
                neighbors.Add(nodes[nx, nz]);
        }
        if (allowDiagonal)
        {
            int[] ddx = { -1, -1, 1, 1 };
            int[] ddz = { -1, 1, -1, 1 };
            for (int i = 0; i < 4; i++)
            {
                int nx = node.row + ddx[i];
                int nz = node.col + ddz[i];
                if (nx >= 0 && nx < width && nz >= 0 && nz < height)
                {
                    bool side1 = nodes[node.row + ddx[i], node.col].walkable;
                    bool side2 = nodes[node.row, node.col + ddz[i]].walkable;
                    if (side1 && side2)
                        neighbors.Add(nodes[nx, nz]);
                }
            }
        }
        return neighbors;
    }

    // 查找距离指定节点最近的可通行节点。
    public GFM_GridNode FindNearestWalkable(Vector3 worldPos)
    {
        GFM_GridNode node = GetNodeFromWorldPos(worldPos);
        if (node != null && node.walkable) return node;

        float minDist = Mathf.Infinity;
        GFM_GridNode nearest = null;
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                if (!nodes[x, y].walkable) continue;
                float dist = (worldPos.x - nodes[x, y].worldX) * (worldPos.x - nodes[x, y].worldX)
                           + (worldPos.z - nodes[x, y].worldZ) * (worldPos.z - nodes[x, y].worldZ);
                if (dist < minDist) { minDist = dist; nearest = nodes[x, y]; }
            }
        }
        return nearest;
    }
}
