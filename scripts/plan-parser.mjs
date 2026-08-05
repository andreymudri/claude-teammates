const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/
const FILES_HEADING = /^\*\*Files:\*\*\s*$/
const FILE_LINE = /^-\s+(?:Create|Modify|Test)\s*:\s*`([^`]+)`\s*$/
const DEPENDS_LINE = /^\*\*Depends:\*\*\s*(.+?)\s*$/
const SECTION_BREAK = /^(\*\*|###|- \[[ x]\])/

export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/)
  const tasks = []
  const seen = new Set()
  let current = null
  let inFiles = false

  for (const line of lines) {
    const heading = TASK_HEADING.exec(line)
    if (heading) {
      const id = `T${heading[1]}`
      if (seen.has(id)) throw new Error(`duplicate task id: ${id}`)
      seen.add(id)
      current = { id, title: heading[2], files: [], deps: [] }
      tasks.push(current)
      inFiles = false
      continue
    }
    if (!current) continue

    if (FILES_HEADING.test(line)) { inFiles = true; continue }

    const depends = DEPENDS_LINE.exec(line)
    if (depends) {
      current.deps = depends[1].split(',').map((d) => d.trim()).filter(Boolean)
      inFiles = false
      continue
    }

    if (inFiles) {
      const file = FILE_LINE.exec(line)
      if (file) {
        current.files.push(file[1].split(':')[0])
        continue
      }
      if (line.trim() !== '' && SECTION_BREAK.test(line.trim())) inFiles = false
    }
  }

  return tasks
}
