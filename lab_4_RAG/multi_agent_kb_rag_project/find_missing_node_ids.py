import re

# Paths to your files (edit if needed)
nodes_path = 'sql/nodes.sql'
attributes_path = 'sql/attributes.sql'
missing_ids_path = 'sql/missing_node_ids.txt'

# 1. Collect all node_ids from nodes.sql
node_ids = set()
with open(nodes_path, 'r', encoding='utf-8') as f:
    for line in f:
        m = re.search(r"INSERT INTO nodes.*?\('(.*?)'", line)
        if m:
            node_ids.add(m.group(1))

# 2. Scan attributes.sql for referenced node_ids
missing = set()
with open(attributes_path, 'r', encoding='utf-8') as f:
    for line in f:
        m = re.search(r"\(([^,]+),", line)
        if m:
            ref_id = m.group(1).strip("'\"")
            if ref_id and ref_id not in node_ids:
                missing.add(ref_id)

# 3. Output missing node_ids
with open(missing_ids_path, 'w', encoding='utf-8') as f:
    for node_id in sorted(missing):
        f.write(node_id + '\n')

print(f"Found {len(missing)} missing node_ids. See {missing_ids_path}")
