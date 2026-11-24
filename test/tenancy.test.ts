import { describe, expect, it } from 'vitest';
import { workflowRefVerdict } from '../src/tenancy';

const release = 'owner/repo/.github/workflows/release.yml';

describe('workflowRefVerdict', () => {
  it('lets everything through when the project has no allow-list', () => {
    expect(workflowRefVerdict(undefined, undefined)).toEqual({ kind: 'exact' });
    expect(workflowRefVerdict([], `${release}@refs/tags/v1.0.0`)).toEqual({ kind: 'exact' });
  });

  it('denies a missing claim when the project has an allow-list', () => {
    expect(workflowRefVerdict([`${release}@refs/heads/main`], undefined)).toEqual({ kind: 'denied' });
  });

  it('accepts a listed ref as is', () => {
    expect(workflowRefVerdict([`${release}@refs/tags/v1.0.0`], `${release}@refs/tags/v1.0.0`))
      .toEqual({ kind: 'exact' });
  });

  it('sends a tag to the branches listed for the same workflow', () => {
    expect(workflowRefVerdict(
      [`${release}@refs/heads/master`, `${release}@refs/heads/release/1.x`],
      `${release}@refs/tags/v1.2.0`
    )).toEqual({ kind: 'tag', tag: 'v1.2.0', branches: ['master', 'release/1.x'] });
  });

  it('denies a tag when only other workflows or repositories are listed', () => {
    const listed = [
      'other/repo/.github/workflows/release.yml@refs/heads/master',
      'owner/repo/.github/workflows/deploy.yml@refs/heads/master',
      `${release}@refs/tags/v1.1.0`,
    ];
    expect(workflowRefVerdict(listed, `${release}@refs/tags/v1.2.0`)).toEqual({ kind: 'denied' });
  });

  it('denies an unlisted ref that is not a tag', () => {
    expect(workflowRefVerdict([`${release}@refs/heads/master`], `${release}@refs/heads/develop`))
      .toEqual({ kind: 'denied' });
  });
});
