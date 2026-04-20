import { describe, it, expect } from "vitest";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";

describe("AppError", () => {
  it("has statusCode, message, and name", () => {
    const err = new AppError(400, "Bad request");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Bad request");
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores details", () => {
    const details = { field: "name" };
    const err = new AppError(400, "Invalid", details);
    expect(err.details).toEqual(details);
  });

  it("works without details", () => {
    const err = new AppError(500, "Internal");
    expect(err.details).toBeUndefined();
  });
});

describe("NotFoundError", () => {
  it("formats message with resource and id", () => {
    const err = new NotFoundError("Task", 42);
    expect(err.message).toBe("Task #42 not found");
    expect(err.statusCode).toBe(404);
  });

  it("formats message with resource only", () => {
    const err = new NotFoundError("Project");
    expect(err.message).toBe("Project not found");
  });

  it("handles id=0", () => {
    const err = new NotFoundError("Task", 0);
    expect(err.message).toBe("Task #0 not found");
  });

  it("handles string id", () => {
    const err = new NotFoundError("Key", "abc");
    expect(err.message).toBe("Key #abc not found");
  });

  it("is an instance of AppError", () => {
    const err = new NotFoundError("X");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ValidationError", () => {
  it("has 422 status code", () => {
    const err = new ValidationError("Field required");
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe("Field required");
  });

  it("stores field details", () => {
    const details = { name: ["required"], email: ["invalid format"] };
    const err = new ValidationError("Validation failed", details);
    expect(err.details).toEqual(details);
  });

  it("is an instance of AppError", () => {
    const err = new ValidationError("Bad");
    expect(err).toBeInstanceOf(AppError);
  });
});
