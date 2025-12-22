// Migration script: Add 'await' to all db calls in manager.js
const fs = require('fs');

let content = fs.readFileSync('manager.js', 'utf8');

// Pattern to match db function calls that need await
// We need to be careful not to double-await

// Replace "= query(" with "= await query(" if not already awaited
content = content.replace(/(\s*const\s+\w+\s*=\s*)(?!await\s)(query\()/g, '$1await $2');

// Replace "= get(" with "= await get("  if not already awaited
content = content.replace(/(\s*const\s+\w+\s*=\s*)(?!await\s)(get\()/g, '$1await $2');

// Replace standalone "run(" with "await run(" (for statements without const)
// But not "return run(" which should become "return await run("
content = content.replace(/(return\s+)(?!await\s)(run\()/g, '$1await $2');
content = content.replace(/(return\s+)(?!await\s)(query\()/g, '$1await $2');
content = content.replace(/(return\s+)(?!await\s)(get\()/g, '$1await $2');

// For lines that are just "run(...)" without const/return
content = content.replace(/^(\s+)(?!await\s)(run\()/gm, '$1await $2');

// Make sure we don't have "await await"
content = content.replace(/await\s+await/g, 'await');

fs.writeFileSync('manager.js', content, 'utf8');
console.log('Migration complete!');

// Count remaining patterns
const remaining = (content.match(/(?<!await\s)(query\(|run\(|get\()/g) || []).length;
console.log(`Remaining un-awaited calls: ${remaining}`);
