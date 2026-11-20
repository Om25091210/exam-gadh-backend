/** First names for the labelled practice partner. The app always shows a "Practice partner" tag next to it. */
export const BOT_NAMES = [
  'Aarav', 'Aditi', 'Akash', 'Ananya', 'Anil', 'Anjali', 'Arjun', 'Bhavna', 'Chandan', 'Deepak', 'Divya', 'Gaurav',
  'Geeta', 'Harsh', 'Isha', 'Jyoti', 'Kavita', 'Kiran', 'Komal', 'Lokesh', 'Mahesh', 'Manish', 'Meena', 'Mohit',
  'Neha', 'Nikhil', 'Pooja', 'Prakash', 'Pratik', 'Priya', 'Rahul', 'Rajesh', 'Rakesh', 'Ritu', 'Rohan', 'Sandeep',
  'Sanjay', 'Savita', 'Shivani', 'Sneha', 'Sunil', 'Suresh', 'Tanvi', 'Umesh', 'Vandana', 'Vikas', 'Vishal', 'Yogesh',
];

export function randomBotName(avoid?: string, rnd: () => number = Math.random): string {
  const pool = BOT_NAMES.filter((n) => !avoid || !avoid.toLowerCase().startsWith(n.toLowerCase()));
  return pool[Math.floor(rnd() * pool.length)];
}
