// Example reports for the home page's "See a sample report" section.
// Texts written for Inkprint; the scores are illustrative example data, not accuracy claims.
// Each paragraph is a list of [sentence, example score 0..1].

export const SAMPLES = {
  human: {
    label: 'Human essay',
    score: 0.09,
    paragraphs: [
      [
        ['My grandmother never wrote anything down.', 0.08],
        ['Recipes, phone numbers, the name of the boy who broke my mother’s bike in 1974 — she kept all of it in her head, and she’d tell you, whether you asked or not.', 0.05],
        ['So when she started forgetting, it didn’t look like forgetting at first.', 0.12],
        ['It looked like stubbornness.', 0.06],
      ],
      [
        ['She’d put salt in the tea.', 0.04],
        ['She’d insist it was Tuesday.', 0.07],
        ['My mum got angry, then quiet, then started a notebook of her own: dates, doses, what Gran ate, what she said that seemed odd.', 0.1],
        ['I read it last winter.', 0.05],
        ['Half of it is lists.', 0.09],
        ['The other half is my mum talking to herself, which I’d never heard her do out loud.', 0.11],
      ],
      [
        ['I don’t have a neat ending for this.', 0.06],
        ['I’m writing it because the notebook made me realise that remembering is work, and somebody always ends up doing it.', 0.22],
      ],
    ],
  },
  ai: {
    label: 'AI essay',
    score: 0.91,
    paragraphs: [
      [
        ['In today’s fast-paced world, technology plays a crucial role in shaping how students learn.', 0.94],
        ['It is important to note that digital tools offer both opportunities and challenges.', 0.91],
        ['By understanding these factors, educators can foster a more effective learning environment.', 0.89],
      ],
      [
        ['Firstly, online platforms provide access to a wide range of resources.', 0.86],
        ['Students can explore topics at their own pace, which enhances engagement and motivation.', 0.88],
        ['Moreover, collaborative tools allow learners to connect with peers across the globe.', 0.92],
        ['This fosters communication skills that are essential in the modern workplace.', 0.87],
      ],
      [
        ['However, it is essential to consider the potential drawbacks.', 0.84],
        ['Excessive screen time can impact concentration and overall well-being.', 0.71],
        ['Furthermore, not all students have equal access to devices and reliable internet.', 0.76],
      ],
      [
        ['In conclusion, technology serves as a powerful tool in education.', 0.95],
        ['By striking a balance between innovation and mindful use, schools can ensure that every student thrives.', 0.93],
      ],
    ],
  },
  mixed: {
    label: 'Mixed',
    score: 0.48,
    paragraphs: [
      [
        ['Volunteering plays a vital role in building stronger communities.', 0.88],
        ['It is worth noting that it also offers numerous benefits for the volunteers themselves.', 0.83],
      ],
      [
        ['Last summer I spent six Saturdays sorting tins at the food bank on Mill Road.', 0.12],
        ['The first week I put the beans with the soup and nobody noticed until a man named Keith, who has been there since 2009, sighed very loudly.', 0.06],
        ['After that I learned the system.', 0.18],
        ['Beans go left.', 0.09],
        ['Everything with a ring-pull goes on the bottom shelf, because the older visitors can’t always open the other kind.', 0.21],
      ],
      [
        ['I didn’t feel heroic.', 0.15],
        ['Mostly I felt cold, and a bit useless, until the day a kid asked me where the cereal was and I actually knew.', 0.1],
      ],
      [
        ['Ultimately, volunteering fosters empathy, responsibility and a sense of belonging.', 0.9],
        ['In conclusion, everyone should consider giving their time to a cause they care about.', 0.92],
      ],
    ],
  },
};

// The same shape the Worker returns, so a sample runs through the real report code.
export function sampleDetection(key) {
  const s = SAMPLES[key];
  return {
    text: s.paragraphs.map((p) => p.map(([t]) => t).join(' ')).join('\n\n'),
    detection: { detector: 'Example data', score: s.score, sentences: s.paragraphs.flat().map(([text, score]) => ({ text, score })) },
  };
}
