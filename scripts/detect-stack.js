'use strict';

// 프로젝트 빌드 파일을 보고 기술 스택 + 합리적 verify_commands 자동 추론.
// /pact:init이 호출 — 사용자에게 질문 줄임.

const fs = require('fs');
const path = require('path');

function exists(cwd, file) {
  return fs.existsSync(path.join(cwd, file));
}

function readPackageJson(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return { scripts: pkg.scripts || {}, deps: { ...pkg.dependencies, ...pkg.devDependencies } };
  } catch {
    return null;
  }
}

/**
 * 스택 감지 + verify_commands 추천.
 * @param {string} cwd
 * @returns {{stack: string, verify_commands: {lint, typecheck, test, build}}}
 */
function detectStack(cwd = process.cwd()) {
  // Node / TypeScript
  if (exists(cwd, 'package.json')) {
    const pkg = readPackageJson(cwd);
    const scripts = pkg ? pkg.scripts : {};
    const deps = pkg ? pkg.deps : {};
    const hasTs = exists(cwd, 'tsconfig.json') || !!deps.typescript;
    return {
      stack: hasTs ? 'node-typescript' : 'node',
      verify_commands: {
        lint: scripts.lint ? 'npm run lint' : 'skip',
        typecheck: hasTs ? (scripts.typecheck ? 'npm run typecheck' : 'tsc --noEmit') : 'skip',
        test: scripts.test ? 'npm test' : 'skip',
        build: scripts.build ? 'npm run build' : 'skip',
      },
    };
  }

  // Java — Maven
  if (exists(cwd, 'pom.xml')) {
    return {
      stack: 'java-maven',
      verify_commands: {
        lint: 'skip',
        typecheck: 'skip',
        test: 'mvn test',
        build: 'mvn package',
      },
    };
  }

  // Java / Kotlin — Gradle
  if (exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) {
    const wrapper = exists(cwd, 'gradlew') ? './gradlew' : 'gradle';
    return {
      stack: 'java-gradle',
      verify_commands: {
        lint: `${wrapper} check`,
        typecheck: 'skip',
        test: `${wrapper} test`,
        build: `${wrapper} build`,
      },
    };
  }

  // Rust
  if (exists(cwd, 'Cargo.toml')) {
    return {
      stack: 'rust',
      verify_commands: {
        lint: 'cargo clippy',
        typecheck: 'cargo check',
        test: 'cargo test',
        build: 'cargo build',
      },
    };
  }

  // Go
  if (exists(cwd, 'go.mod')) {
    return {
      stack: 'go',
      verify_commands: {
        lint: 'skip',
        typecheck: 'go vet ./...',
        test: 'go test ./...',
        build: 'go build ./...',
      },
    };
  }

  // Python
  if (exists(cwd, 'pyproject.toml') || exists(cwd, 'requirements.txt') || exists(cwd, 'setup.py')) {
    return {
      stack: 'python',
      verify_commands: {
        lint: 'skip',
        typecheck: 'skip',
        test: 'pytest',
        build: 'skip',
      },
    };
  }

  // Ruby
  if (exists(cwd, 'Gemfile')) {
    return {
      stack: 'ruby',
      verify_commands: {
        lint: 'skip',
        typecheck: 'skip',
        test: 'bundle exec rspec',
        build: 'skip',
      },
    };
  }

  // 미감지
  return {
    stack: 'unknown',
    verify_commands: {
      lint: 'skip',
      typecheck: 'skip',
      test: 'skip',
      build: 'skip',
    },
  };
}

module.exports = { detectStack };

// CLI: node detect-stack.js [<cwd>]
if (require.main === module) {
  const cwd = process.argv[2] || process.cwd();
  process.stdout.write(JSON.stringify(detectStack(cwd), null, 2) + '\n');
}
