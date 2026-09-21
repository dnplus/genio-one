import { expect, test } from "bun:test"

import { defaultDescriptor } from "./BotOwnedSkillsPanel"

test("serializes starter Skill descriptions as YAML strings", () => {
  for (const description of ["Release: verify CI", "# release checklist", "[verify, deploy]"]) {
    const frontmatter = defaultDescriptor("release-check", description).split("---")[1]
    expect(Bun.YAML.parse(frontmatter)).toEqual({ name: "release-check", description })
  }
})
