// The school's course list — whether a class has a final exam (20/60/20 vs
// 20/80 grading split), AP status, GPA weight, and an optional message.
const COURSE_CATALOG = [
  { name: "Algebra II", ap: false, final: false, weight: 1},
  { name: "AP Art", ap: true, final: false, weight: 1, divisions: ["2D", "3D"] },
  { name: "Biology", ap: false, final: false, weight: 1 },
  { name: "AP Biology", ap: true, final: false, weight: 1 },
  { name: "Calculus", ap: false, final: false, weight: 1 },
  { name: "AP Calculus", ap: true, final: false, weight: 1, divisions: ["AB", "BC"] },
  { name: "Chamber Choir", ap: false, final: false, weight: 1 },
  { name: "Chemistry", ap: false, final: false, weight: 1 },
  { name: "AP Chemistry", ap: true, final: false, weight: 1 },
  // divisions: sections that test on different days (e.g. Chinese I-IV);
  // everything else about the course is shared across them.
  { name: "Chinese", ap: false, final: false, weight: 1, divisions: ["I", "II", "III", "IV"] },
  { name: "AP Chinese", ap: true, final: false, weight: 1 },
  { name: "Heritage Chinese", ap: false, final: false, weight: 1 },
  { name: "Choir", ap: false, final: false, weight: 1 },
  { name: "AP Comparative Gov", ap: true, final: false, weight: 1 },
  { name: "Concert Band", ap: false, final: false, weight: 1 },
  { name: "Creative Writing", ap: false, final: false, weight: 1 },
  { name: "AP CSA", ap: true, final: false, weight: 1 },
  { name: "AP CSP", ap: true, final: false, weight: 1 },
  { name: "Debate", ap: false, final: false, weight: 1 },
  { name: "Design and Tech", ap: false, final: false, weight: 1 },
  { name: "Advanced Design and Tech", ap: false, final: false, weight: 1 },
  { name: "Digital Photography", ap: false, final: false, weight: 1 },
  { name: "Earth Science", ap: false, final: false, weight: 1 },
  { name: "Economics", ap: false, final: false, weight: 1 },
  { name: "AP Economics", ap: true, final: false, weight: 1, divisions: ["Mic", "Mac"] },
  { name: "Engineering", ap: false, final: false, weight: 1 },
  { name: "Advanced Engineering", ap: false, final: false, weight: 1 },
  { name: "English", ap: false, final: false, weight: 1, divisions: ["9", "10", "11", "12"] },
  { name: "AP Language", ap: true, final: false, weight: 1 },
  { name: "AP Literature", ap: true, final: false, weight: 1 },
  { name: "AP Environmental Science", ap: true, final: false, weight: 1 },
  { name: "Ethics", ap: false, final: false, weight: 1 },
  { name: "Film as Literature", ap: false, final: false, weight: 1 },
  { name: "Geometry", ap: false, final: false, weight: 1 },
  { name: "Global Studies", ap: false, final: false, weight: 1, divisions: ["9", "10", "11", "12"] },
  { name: "Graphic Design", ap: true, final: false, weight: 1 },
  { name: "Hajun Studies", ap: false, final: false, weight: 0 },
  { name: "AP Human Geography", ap: true, final: false, weight: 1 },
  { name: "Individual/Dual Pursuits", ap: false, final: false, weight: 1 },
  { name: "Journalism", ap: false, final: false, weight: 1 },
  {
    name: "Korean",
    ap: false,
    final: false,
    weight: 1,
    message: "",
    // Applies to the class as a whole, not separately to each combo
    // sub-component below.
    divisions: ["9", "10"],
    combo: [
      { name: "Korean Language", ap: false, final: false, weight: 0.5 },
      { name: "Korean SS", ap: false, final: false, weight: 0.5 },
    ],
  },
  { name: "Linear Algebra", ap: false, final: false, weight: 1 },
  { name: "Lunch", ap: false, final: false, weight: 0 },
  { name: "AP Lunch", ap: true, final: false, weight: 0 },
  { name: "Modern Band", ap: false, final: false, weight: 1 },
  { name: "Movement & Expression", ap: false, final: false, weight: 1 },
  { name: "Multivariable Calculus", ap: false, final: false, weight: 1 },
  { name: "AP Music Theory", ap: true, final: false, weight: 1 },
  { name: "PE", ap: false, final: false, weight: 1 },
  { name: "Personal Fitness", ap: false, final: false, weight: 1 },
  { name: "Physics", ap: false, final: false, weight: 1 },
  { name: "AP Physics", ap: true, final: false, weight: 1, divisions: ["1", "C"] },
  { name: "Pre-Calculus", ap: false, final: false, weight: 1 },
  { name: "Programming", ap: false, final: false, weight: 1, divisions: ["I", "II"] },
  { name: "Psychology", ap: false, final: false, weight: 1 },
  { name: "AP Psychology", ap: true, final: false, weight: 1 },
  { name: "Public Speaking", ap: false, final: false, weight: 1 },
  { name: "Recreational & Lifetime Sports", ap: false, final: false, weight: 1 },
  { name: "AP Research", ap: true, final: false, weight: 1 },
  { name: "Robotics", ap: false, final: false, weight: 1 },
  { name: "Advanced Robotics", ap: false, final: false, weight: 1 },
  { name: "AP Seminar", ap: true, final: false, weight: 1 },
  { name: "Sociology", ap: false, final: false, weight: 1 },
  { name: "Solo Vocal Technique", ap: false, final: false, weight: 1 },
  { name: "Spanish", ap: false, final: false, weight: 1, divisions: ["I", "II", "III", "IV"] },
  { name: "AP Spanish", ap: true, final: false, weight: 1 },
  { name: "AP Statistics", ap: true, final: false, weight: 1 },
  { name: "String Orchestra", ap: false, final: false, weight: 1 },
  { name: "Advanced String Orchestra", ap: false, final: false, weight: 1 },
  { name: "Theater", ap: false, final: false, weight: 1 },
  { name: "Advanced Theater", ap: false, final: false, weight: 1 },
  { name: "AP US Gov", ap: true, final: false, weight: 1 },
  { name: "US History", ap: false, final: false, weight: 1 },
  { name: "AP US History", ap: true, final: false, weight: 1 },
  { name: "Videography", ap: true, final: false, weight: 1 },
  { name: "Visual Art", ap: false, final: false, weight: 1 },
  { name: "Wellness", ap: false, final: false, weight: 1 },
  { name: "Wind Ensemble", ap: false, final: false, weight: 1 },
  { name: "AP World History", ap: true, final: false, weight: 1 },
  { name: "Writing", ap: false, final: false, weight: 1 },
  { name: "Yearbook", ap: false, final: false, weight: 1 },
];

// Looks up a course by name anywhere in the catalog, including inside a
// "combo" course's own sub-entries (e.g. "Korean Lang" inside "Korean").
function findCourseCatalogEntry(name) {
  for (const course of COURSE_CATALOG) {
    if (course.name === name) return course;
    if (course.combo) {
      const sub = course.combo.find((c) => c.name === name);
      if (sub) return sub;
    }
  }
  return null;
}

// A "combo" course is one schedule slot that's really two separate classes
// (e.g. "Korean" -> "Korean Lang" + "Korean SS"). Expands any such names
// into a flat list of the actual classes.
function expandCourseNames(names) {
  return names.flatMap((name) => {
    const course = COURSE_CATALOG.find((c) => c.name === name);
    return course && course.combo ? course.combo.map((c) => c.name) : [name];
  });
}

// The key used to match a period to its assessment dates — a course name
// plus its picked division (e.g. "English (10)") if it has one, otherwise
// just the plain name. Never shown as a display name.
function effectiveCourseName(courseName, division) {
  return division ? `${courseName} (${division})` : courseName;
}
