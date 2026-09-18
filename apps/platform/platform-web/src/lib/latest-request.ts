export class LatestRequestGate {
  private generation = 0

  begin() {
    this.generation += 1
    return this.generation
  }

  isLatest(generation: number) {
    return generation === this.generation
  }
}
