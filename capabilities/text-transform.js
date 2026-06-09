
export const TextTransformPlugin = {
  name: 'text.transform',
  sideEffect: 'read',
  estimateCents: () => 0,
  async invoke(call) {
    const input = call.input;
    let result;
    switch (input.operation) {
      case 'uppercase': result = input.text.toUpperCase(); break;
      case 'lowercase': result = input.text.toLowerCase(); break;
      case 'trim': result = input.text.trim(); break;
      case 'reverse': result = input.text.split('').reverse().join(''); break;
      case 'word-count': result = input.text.trim().split(/\s+/).filter(Boolean).length; break;
      default: throw new Error('unknown operation');
    }
    return { output: { result }, claimedCostCents: 0 };
  },
};
export default TextTransformPlugin;
