/**
 * Knowledge Base Loader
 *
 * Reads markdown files from the knowledge/ directory at runtime,
 * providing context for AI chat responses.
 */

import fs from "node:fs/promises";
import path from "node:path";

const KNOWLEDGE_DIR = path.resolve(process.cwd(), "knowledge");

/**
 * Read all markdown files from the knowledge directory recursively
 * and return their contents as an array of strings.
 */
export async function readKnowledgeBase(): Promise<string[]> {
  const entries: string[] = [];

  try {
    await fs.access(KNOWLEDGE_DIR);
  } catch {
    return entries;
  }

  const files = await collectMdFiles(KNOWLEDGE_DIR);

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const relativePath = path.relative(KNOWLEDGE_DIR, filePath);
      entries.push(`## 📄 ${relativePath}\n\n${content}`);
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

async function collectMdFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];

  try {
    entries = await fs.readdir(dir);
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const subFiles = await collectMdFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.endsWith(".md")) {
        files.push(fullPath);
      }
    } catch {
      // Skip inaccessible entries
    }
  }

  return files;
}
