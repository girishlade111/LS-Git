/** Built-in initialization content catalogs (compact, curated). */

export const GITIGNORE_TEMPLATES: Record<string, string> = {
  Node: `# Logs
logs/
*.log
npm-debug.log*
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
`,

  Python: `__pycache__/
*.py[cod]
*.egg-info/
.venv/
venv/
build/
dist/
.coverage
.pytest_cache/
.mypy_cache/
.ruff_cache/
.env
`,

  Go: `bin/
*.exe
*.test
*.out
vendor/`,
  Rust: `/target
Cargo.lock.orig
*.pdb
.env
`,

  Generic: `# Build artifacts
dist/
build/
out/
# Environment & secrets
.env
.env.*
!.env.example
# Editor
.idea/
.vscode/
*.swp
.DS_Store
`,
}

export interface LicenseTemplate {
  key: string
  name: string
  body: string
}

export const LICENSE_TEMPLATES: Array<LicenseTemplate> = [
  {
    key: 'mit',
    name: 'MIT License',
    body: `MIT License

Copyright (c) ${new Date().getFullYear()} <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },
  {
    key: 'apache-2.0',
    name: 'Apache License 2.0',
    body: `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`,
  },
]

export function gitignoreFor(key: string | null): string | null {
  if (!key) return null
  const t = GITIGNORE_TEMPLATES[key]
  return t ?? null
}

export function licenseFor(key: string | null): { fileName: string; body: string } | null {
  if (!key) return null
  const lic = LICENSE_TEMPLATES.find((l) => l.key === key.toLowerCase())
  if (!lic) return null
  return { fileName: 'LICENSE', body: lic.body }
}
