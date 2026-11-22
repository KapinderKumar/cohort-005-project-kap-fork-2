import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 6, 13, 0, 0);
const LATEST = new Date(2026, 9, 6, 14, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("bookmarking a Lesson", () => {
  it("bookmarks a Lesson with no Bookmark, and removes it when toggled again", () => {
    expect(toggleBookmark(db, base.user.id, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);

    expect(toggleBookmark(db, base.user.id, lessonIds[0], LATER)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId: lessonIds[0] })
        .run()
    ).toThrow();
    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("creates a Note on a Lesson with none, trimmed", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "  # not a heading  ", NOW)).toEqual({
      ok: true,
      note: { body: "# not a heading", updatedAt: NOW.toISOString() },
    });
  });

  it("replaces the body and moves the last-edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thoughts", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Second thoughts", LATER);

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Second thoughts",
      updatedAt: LATER.toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "a".repeat(2000), NOW).ok).toBe(true);
  });

  it("refuses a Note over 2,000 characters", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "a".repeat(2001), NOW)).toEqual({
      ok: false,
      error: "A Note must be 2000 characters or fewer.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["tabs and newlines only", "\t\n \r\n\t"],
  ])("refuses a Note that is %s", (_, body) => {
    expect(saveNote(db, base.user.id, lessonIds[0], body, NOW)).toEqual({
      ok: false,
      error: "Write something before saving your Note.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeNull();
  });

  it("refuses a whitespace-only re-save and keeps the existing Note", () => {
    saveNote(db, base.user.id, lessonIds[0], "Keep this", NOW);

    expect(saveNote(db, base.user.id, lessonIds[0], "  \n  ", LATER).ok).toBe(false);
    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Keep this",
      updatedAt: NOW.toISOString(),
    });
  });
});

describe("the Saved lists", () => {
  it("contain only the Student's own rows, newest first, with Lesson and Course", () => {
    const other = addStudent("Other");
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[1], LATER);
    toggleBookmark(db, other.id, lessonIds[0], LATEST);
    saveNote(db, base.user.id, lessonIds[1], "Older", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Newer", LATER);
    saveNote(db, other.id, lessonIds[0], "Not yours", LATEST);

    expect(listBookmarks(db, base.user.id)).toMatchObject([
      { lessonId: lessonIds[1], lessonTitle: "Lesson 2", courseTitle: "Test Course", courseSlug: "test-course" },
      { lessonId: lessonIds[0], lessonTitle: "Lesson 1", courseTitle: "Test Course", courseSlug: "test-course" },
    ]);
    expect(listNotes(db, base.user.id).map((note) => note.body)).toEqual([
      "Newer",
      "Older",
    ]);
  });

  it("puts a re-edited Note back at the top", () => {
    saveNote(db, base.user.id, lessonIds[0], "One", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Two", LATER);
    saveNote(db, base.user.id, lessonIds[0], "One, edited", LATEST);

    expect(listNotes(db, base.user.id).map((note) => note.lessonId)).toEqual([
      lessonIds[0],
      lessonIds[1],
    ]);
  });
});

describe("approving a Refund Request", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: new Date(2026, 9, 4).toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not for me.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });
});
