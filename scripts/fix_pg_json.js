// Fix PostgreSQL compatibility issues in manager.js
const fs = require('fs');

let content = fs.readFileSync('manager.js', 'utf8');

// 1. Convert json_extract to PostgreSQL syntax
// SQLite: json_extract(col, '$.field')
// PostgreSQL: (col::json->>'field')

// Pattern: json_extract(column, '$.fieldName')
content = content.replace(/json_extract\(([^,]+),\s*'\$\.(\w+)'\)/g, "($1::json->>'$2')");

// 2. Fix GROUP BY issues - need to add all non-aggregated columns
// This is trickier and needs manual review, but let's fix the common patterns

fs.writeFileSync('manager.js', content, 'utf8');
console.log('Converted json_extract to PostgreSQL syntax');

// Verify
const remaining = (content.match(/json_extract/g) || []).length;
console.log(`Remaining json_extract calls: ${remaining}`);
