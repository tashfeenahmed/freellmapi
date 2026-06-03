import re

with open('client/src/pages/AnalyticsPage.tsx', 'r') as f:
    content = f.read()

# Add overflow-x-auto wrapper around Per-model breakdown table
table_per_model_old = """                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>"""
table_per_model_new = """                <div className="max-h-[360px] overflow-y-auto overflow-x-auto -mx-4">
                  <Table className="min-w-[600px]">"""
content = content.replace(table_per_model_old, table_per_model_new)

# Add overflow-x-auto wrapper around Recent errors table
table_errors_old = """              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>"""
table_errors_new = """              <div className="max-h-[240px] overflow-y-auto overflow-x-auto -mx-4">
                <Table className="min-w-[500px]">"""
content = content.replace(table_errors_old, table_errors_new)

# Make sure grid for summary stats flows correctly
content = content.replace(
    '<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">',
    '<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">'
)

with open('client/src/pages/AnalyticsPage.tsx', 'w') as f:
    f.write(content)

print("Analytics patch applied successfully")
