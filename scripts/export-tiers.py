#!/usr/bin/env python3
"""Export tier chains from JiMesh database"""
import sqlite3
import json
import os
from collections import defaultdict

db_path = '/home/ji/projects/jimesh/server/data/freeapi.db'
output_dir = '/home/ji/projects/jimesh/data/chains'

os.makedirs(output_dir, exist_ok=True)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get all enabled models grouped by intelligence rank tier
cursor.execute("""
    SELECT
        id, platform, model_id, display_name, intelligence_rank,
        supports_vision, supports_tools
    FROM models
    WHERE enabled = 1
    ORDER BY intelligence_rank ASC, platform, model_id
""")

models = []
for row in cursor.fetchall():
    models.append({
        "id": row[0],
        "platform": row[1],
        "model_id": row[2],
        "display_name": row[3],
        "intelligence_rank": row[4],
        "supports_vision": bool(row[5]),
        "supports_tools": bool(row[6]),
    })

# Define tier ranges based on intelligence_rank
# S-Tier: Top models (rank 1-3)
# A-Tier: Excellent (rank 4-7)
# B-Tier: Good (rank 8+)
TIER_DEFINITIONS = {
    "s-tier": {
        "name": "S-Tier",
        "description": "Top intelligence models for critical tasks",
        "intelligence_range": [1, 3],
        "emoji": "🌟",
        "color": "#f59e0b",
    },
    "a-tier": {
        "name": "A-Tier",
        "description": "High quality models for most tasks",
        "intelligence_range": [4, 7],
        "emoji": "⭐",
        "color": "#3b82f6",
    },
    "b-tier": {
        "name": "B-Tier",
        "description": "Good models for simple/fast tasks",
        "intelligence_range": [8, 999],
        "emoji": "✨",
        "color": "#8b5cf6",
    },
}

# Assign models to tiers
chains = {}
for tier_id, tier_def in TIER_DEFINITIONS.items():
    min_rank, max_rank = tier_def["intelligence_range"]
    tier_models = [m for m in models if min_rank <= m["intelligence_rank"] <= max_rank]

    # Group by platform for provider requirements
    platform_counts = defaultdict(int)
    for m in tier_models:
        platform_counts[m["platform"]] += 1

    # Sort by platform diversity (more platforms = better fallback)
    sorted_models = sorted(tier_models, key=lambda m: (m["intelligence_rank"], m["platform"], m["model_id"]))

    chains[tier_id] = {
        "id": tier_id,
        "name": tier_def["name"],
        "description": tier_def["description"],
        "emoji": tier_def["emoji"],
        "color": tier_def["color"],
        "intelligence_range": tier_def["intelligence_range"],
        "model_count": len(tier_models),
        "platforms_required": sorted(platform_counts.keys()),
        "platform_counts": dict(platform_counts),
        "models": [
            {
                "priority": idx + 1,
                "platform": m["platform"],
                "model_id": m["model_id"],
                "display_name": m["display_name"],
                "intelligence_rank": m["intelligence_rank"],
                "supports_vision": m["supports_vision"],
                "supports_tools": m["supports_tools"],
            }
            for idx, m in enumerate(sorted_models)
        ],
    }

# Generate the main export file
export_data = {
    "version": "1.0.0",
    "generated_at": "2026-08-30",
    "description": "Default tier chains for JiMesh - exported from FreeLLMAPI catalog",
    "usage": "Import these chains in JiMesh via /api/profiles or the UI",
    "tiers": chains,
}

# Write main export
main_file = os.path.join(output_dir, "default-tiers.json")
with open(main_file, "w") as f:
    json.dump(export_data, f, indent=2)
print(f"✅ Wrote {main_file}")

# Write per-tier files
for tier_id, chain in chains.items():
    tier_file = os.path.join(output_dir, f"{tier_id}.json")
    with open(tier_file, "w") as f:
        json.dump(chain, f, indent=2)
    print(f"✅ Wrote {tier_file} ({chain['model_count']} models)")

# Write a "provider requirements" file that shows what keys are needed
provider_requirements = {}
for tier_id, chain in chains.items():
    for platform in chain["platforms_required"]:
        if platform not in provider_requirements:
            provider_requirements[platform] = {
                "platform": platform,
                "tiers": [],
                "model_count": 0,
            }
        provider_requirements[platform]["tiers"].append(tier_id)
        provider_requirements[platform]["model_count"] += chain["platform_counts"][platform]

# Sort by model count (most important first)
provider_requirements = dict(
    sorted(provider_requirements.items(), key=lambda x: -x[1]["model_count"])
)

# Add "tier" badge
for platform, req in provider_requirements.items():
    if "s-tier" in req["tiers"]:
        req["priority"] = "critical"
    elif "a-tier" in req["tiers"]:
        req["priority"] = "high"
    else:
        req["priority"] = "medium"

requirements_file = os.path.join(output_dir, "provider-requirements.json")
with open(requirements_file, "w") as f:
    json.dump({
        "version": "1.0.0",
        "generated_at": "2026-08-30",
        "description": "Provider API key requirements for default tier chains",
        "note": "Without these API keys configured in JiMesh, the corresponding models will be skipped",
        "providers": provider_requirements,
    }, f, indent=2)
print(f"✅ Wrote {requirements_file}")

# Generate a markdown summary
md_lines = [
    "# JiMesh Default Tier Chains",
    "",
    f"**Generated:** 2026-08-30",
    f"**Source:** FreeLLMAPI catalog (329 models, 27 providers)",
    "",
    "## 📊 Summary",
    "",
]
for tier_id, chain in chains.items():
    md_lines.append(f"- **{chain['emoji']} {chain['name']}** ({tier_id}): {chain['model_count']} models across {len(chain['platforms_required'])} providers")

md_lines.extend([
    "",
    "## 🔑 Provider Requirements",
    "",
    "These providers need API keys configured in JiMesh for the chains to work:",
    "",
    "| Provider | Tiers | Models | Priority |",
    "|----------|-------|--------|----------|",
])

for platform, req in provider_requirements.items():
    tiers_str = ", ".join(req["tiers"])
    md_lines.append(f"| `{platform}` | {tiers_str} | {req['model_count']} | {req['priority']} |")

md_lines.extend([
    "",
    "## 📥 How to Import",
    "",
    "### Via UI",
    "1. Open JiMesh dashboard",
    "2. Go to **Settings → Profiles**",
    "3. Click **Import**",
    "4. Select `default-tiers.json`",
    "",
    "### Via API",
    "```bash",
    "curl -X POST http://localhost:3010/api/profiles/import \\",
    "  -H \"Content-Type: application/json\" \\",
    "  -d @data/chains/default-tiers.json",
    "```",
    "",
    "## 🎯 Tier Details",
    "",
])

for tier_id, chain in chains.items():
    md_lines.extend([
        f"### {chain['emoji']} {chain['name']} (`{tier_id}`)",
        "",
        f"_{chain['description']}_",
        "",
        f"- **Models:** {chain['model_count']}",
        f"- **Providers:** {len(chain['platforms_required'])} ({', '.join(chain['platforms_required'][:5])}{'...' if len(chain['platforms_required']) > 5 else ''})",
        f"- **Intelligence Range:** {chain['intelligence_range'][0]} - {chain['intelligence_range'][1]}",
        "",
        "**Top 10 models:**",
        "",
    ])
    for m in chain["models"][:10]:
        flags = []
        if m["supports_vision"]:
            flags.append("👁️")
        if m["supports_tools"]:
            flags.append("🔧")
        flag_str = " ".join(flags) if flags else ""
        md_lines.append(f"- `{m['model_id']}` ({m['platform']}) {flag_str} - {m['display_name']}")
    md_lines.append("")

md_file = os.path.join(output_dir, "README.md")
with open(md_file, "w") as f:
    f.write("\n".join(md_lines))
print(f"✅ Wrote {md_file}")

# Final summary
print()
print("=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"Total models exported: {sum(c['model_count'] for c in chains.values())}")
print(f"Total providers needed: {len(provider_requirements)}")
print(f"Output directory: {output_dir}")
print()
print("Files created:")
for f in os.listdir(output_dir):
    full = os.path.join(output_dir, f)
    size = os.path.getsize(full)
    print(f"  {f:40s} {size:>8d} bytes")

conn.close()
