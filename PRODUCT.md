# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: a public reader looking for a long-form post from X worth their time.**
They arrive cold — often from a shared link, often from search — and frequently
without an X account. Their job is to find something worthwhile, judge whether it
is, and read it comfortably. They did not come for the site; they came for an
article, and the site has to earn the rest of their attention.

**Secondary, internal: the operator.** One person who discovers articles worth
keeping, pastes their URLs into the admin, reviews what the pipeline produced,
and decides what publishes. This is a back-office role, not an audience — the
admin is deliberately excluded from localization and gets no design charity.

No other audience is confirmed. There is no paid tier, no account-gated content,
and no reader-facing feature behind a login.

## Product Purpose

An archive of long-form posts from X. It exists because that material is hard to
find again once it scrolls past, uncomfortable to read on X itself, and able to
vanish.

**Success is a stable returning readership.** Not raw traffic, not the size of
the corpus for its own sake. A reader who comes back because the archive is
trustworthy and pleasant to browse.

Explicitly *not* what this is: it is not a crawler over all of X, and it is not a
real-time trending board. Both are stated exclusions in the spec, not omissions.

## Positioning

Four things about this archive that a neighboring product could not truthfully
copy:

1. **The selection is the product.** Someone decides what is worth keeping before
   anything else happens. The volume is deliberately small — the whole archive is
   under a hundred articles — and that smallness is the curation signal.
2. **The original body is actually readable here.** Long-form X content is often
   gated, expiring, or awkward to read in place. The full article is archived and
   renders logged-out, which is the single most load-bearing promise on the site.
3. **Four ranking signals are kept separately inspectable.** Popularity, velocity,
   AI quality and an editor score are blended with configurable weights, and the
   about page names all four. No single opaque number decides what a reader sees.
4. **Rights are a first-class state, not an error.** Excerpt-only, link-only and
   taken-down are normal, expected conditions with their own rendering. A
   takedown admits itself rather than pretending the link never existed.

Underneath all four: the entire thing runs on Cloudflare — Workers, D1, R2,
Queues, Browser Run, Workers AI. No search cluster, no self-hosted browser fleet,
no separate VPS.

## Operating Context

- **Ingest is manual and human-triggered.** The operator pastes X Article URLs;
  normalization, dedup, the Browser Run crawl, archival, parsing, classification
  and ranking all follow without further input. Articles do not enter the archive
  by being crawled indiscriminately.
- **The corpus is substantially not English.** A large share of the archived
  articles are Chinese or Japanese, while the interface is English-first. Content
  and chrome speak different languages on much of the site.
- **Three interface languages**, chosen by the reader and held in a cookie. The
  header must fit at all three, and English is the widest of them.
- **The archive's own record is the source of truth for what is live.** The
  checked-in spec describes intent; the running deployment is verified
  individually, claim by claim.

## Capabilities and Constraints

**Confirmed capabilities.** URL import with normalization and dedup; Browser Run
crawl with raw HTML, Markdown and screenshot archived to R2; parsing to a
versioned internal document; plain-text full-text search including Chinese and
Japanese; automatic AI categorization on import; four-signal ranking; editor
picks; category, tag, author and search pages; RSS feed and sitemap; saved
articles; content-governance states (full, excerpt, link-only, takedown).

**Constraints future work must respect.**

- Every reading page links back to the original. Attribution belongs to the
  original author, always.
- Archived is not republished. A rights decision is recorded per article and
  governs how much of it renders.
- The Workers AI daily free allocation is shared by cover generation and
  article categorization. Spending it freely on one stops the other.
- Roughly seven in ten articles carry no engagement data, so ranking leans on
  whatever is actually measurable for most of the archive.
- Two articles are permanently unarchivable — their source posts are gone. They
  stay in the record as failures rather than being quietly dropped.

**Open product decisions, deliberately undecided.**

- Translating article bodies into all three interface languages. A design exists;
  the work is deferred.
- AI-written summaries, topics, tags and quality scores. Only categorization is
  wired; the rest would each cost a model call against the same shared quota and
  have no reader waiting for them.
- Whether to hide empty categories from navigation. Currently they are listed,
  which surfaces a category with nothing in it.

## Brand Commitments

- **Name:** X Article Hub.
- **Voice: institutional archive.** The site speaks as an archive, in a neutral
  and factual register, and does not editorialize in its own voice.
- **The curator stays invisible.** This is confirmed and binding. Curation is
  described as a *mechanism* — "chosen by a human", "Editor's Picks are a human
  decision" — never attributed to a named person, and no individual is held out
  as a brand. Anything that would make a reader ask "who is behind this?" rather
  than "what did they pick?" is off the table.
- **Original authors are the visible byline.** Every author page, card and
  article header names the writer of the work, not the archivist.

No logo, mascot, tagline, colour commitment or typeface has been established as
binding. None should be invented downstream and then treated as fixed.

## Evidence on Hand

Measured against the live deployment, not from documentation:

| Fact | Value |
|---|---:|
| Articles | 98 |
| Published | 98 |
| Editor's Picks | 3 |
| Distinct authors | 92 |
| Categories | 8 |
| Tags | 23 |
| Admin accounts | 1 |
| Uncategorized articles | 0 |

**Absences that future work must not fabricate.** There is no reader research, no
analytics-derived picture of who reads this or how often, no testimonials, no
press, no customer list and no case studies. Any claim about readership is
currently unevidenced. There is also no analytics instrumentation on the public
site, so "stable returning readership" — the stated success condition — is not
currently measurable.

## Product Principles

1. **Curation is the product; the machine does the rest.** If a reader would
   mistake an automated decision for editorial judgment, that decision is in the
   wrong place.
2. **An archived copy is not a republication.** Rights states are normal
   conditions with their own rendering, and a takedown admits itself.
3. **Reading never depends on being logged in** — not to X, and not here.
4. **No single opaque score decides what surfaces.** The ranking signals stay
   separately inspectable and their blend stays configurable.
5. **The archive admits what it cannot hold.** A failed, removed or missing
   article says so, rather than being silently dropped or quietly faked.
