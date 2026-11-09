// A small built-in sample lecture so Encode can be explored before any API key is set.
window.ENCODE_SAMPLE = {
  title: "Sample: The Cardiac Cycle",
  course: "A&P II (sample)",
  sources: [{
    name: "Cardiac Cycle — lecture slides (sample)",
    kind: "pptx",
    text: `[Slide 1]
The Cardiac Cycle
All events of one heartbeat: contraction (systole) and relaxation (diastole) of atria and ventricles.

[Slide 2]
Pressure drives flow
Blood flows from higher to lower pressure. Valves open and close passively in response to pressure differences.
AV valves (tricuspid, mitral/bicuspid) sit between atria and ventricles. Semilunar valves (pulmonary, aortic) guard the arteries.

[Slide 3]
Phase 1: Ventricular filling (mid-to-late diastole)
Ventricular pressure is low; AV valves open; semilunar valves closed. ~70–80% of filling is passive.
Atrial systole ("atrial kick") tops off the ventricles with the last ~20–30%.
End-diastolic volume (EDV) ≈ 120 mL.

[Slide 4]
Phase 2: Isovolumetric contraction
Ventricles begin to contract; pressure rises above atrial pressure so AV valves close → S1 "lub".
All valves closed, volume does not change, pressure rises rapidly.

[Slide 5]
Phase 3: Ventricular ejection
Ventricular pressure exceeds arterial pressure (≈80 mmHg aorta) → semilunar valves open; blood ejected.
Stroke volume (SV) = EDV − ESV ≈ 70 mL. End-systolic volume (ESV) ≈ 50 mL.

[Slide 6]
Phase 4: Isovolumetric relaxation (early diastole)
Ventricles relax; pressure falls below arterial pressure → semilunar valves close → S2 "dub".
Backflow against the closed aortic valve causes the dicrotic notch. All valves closed again.

[Slide 7]
ECG correlation
P wave = atrial depolarization → atrial contraction. QRS complex = ventricular depolarization → ventricular systole begins.
T wave = ventricular repolarization → ventricles relax.

[Slide 8]
Cardiac output
CO = HR × SV. Typical resting CO ≈ 75 beats/min × 70 mL ≈ 5.25 L/min.
Frank–Starling law: greater EDV (preload) stretches fibers → stronger contraction → larger SV.

[Slide 9]
Clinical connection
Murmurs = abnormal heart sounds from turbulent flow, e.g. stenotic (narrowed) or incompetent (leaky) valves.
Mitral valve prolapse can cause regurgitation into the left atrium during systole.`
  }],
  digest: {
    title: "The Cardiac Cycle",
    overview: "One heartbeat is a pressure-driven cycle: ventricles fill, contract with all valves shut, eject blood, then relax with all valves shut again. Valves open and close passively from pressure differences, producing the heart sounds and lining up with ECG waves.",
    concepts: [
      { id: "c1", name: "Systole vs. diastole", definition: "Systole is contraction (pushing blood out); diastole is relaxation (chambers fill).", why_it_matters: "Blood pressure readings are reported as systolic over diastolic.", source_ref: "Slide 1", visual_hint: "A heart squeezing (red arrows out, labeled systole) next to a relaxed heart filling (blue arrows in, labeled diastole).", mnemonic: "SYStole = SQUEEZE-tole; DIastole = DIlate and fill." },
      { id: "c2", name: "Pressure gradients & valves", definition: "Blood moves from high to low pressure; valves open or close passively when pressure on one side exceeds the other.", why_it_matters: "Explains every valve event and why stiff or leaky valves disrupt flow.", source_ref: "Slide 2", visual_hint: "Two chambers with a one-way door between them; higher pressure side pushes the door open, reversed pressure slams it shut.", mnemonic: "Valves are saloon doors that only swing when the crowd pushes." },
      { id: "c3", name: "Ventricular filling", definition: "During diastole the AV valves are open and ventricles fill mostly passively; the atrial kick adds the final 20–30%.", why_it_matters: "Loss of the atrial kick (e.g., atrial fibrillation) lowers filling and output.", source_ref: "Slide 3", visual_hint: "Ventricle filling like a bathtub: big passive stream then a final squeeze from the atrium labeled 'atrial kick'.", mnemonic: "Fill the tub, then the atrium kicks in the last splash." },
      { id: "c4", name: "Isovolumetric contraction", definition: "Ventricles contract with all four valves closed, so pressure rises sharply while volume stays the same.", why_it_matters: "This phase builds the pressure needed to open the aortic valve.", source_ref: "Slide 4", visual_hint: "A sealed water balloon being squeezed: volume constant, pressure gauge needle climbing.", mnemonic: "Iso-VOLUME = same volume, like squeezing a sealed ketchup bottle before the cap pops." },
      { id: "c5", name: "Ventricular ejection", definition: "When ventricular pressure exceeds arterial pressure, semilunar valves open and blood is ejected into the arteries.", why_it_matters: "Determines stroke volume and therefore cardiac output.", source_ref: "Slide 5", visual_hint: "Ventricle pressure line crossing above aortic pressure line; semilunar valve opening with blood jet.", mnemonic: "Pressure beats the aorta's bouncer (80 mmHg) → doors open, blood parties out." },
      { id: "c6", name: "Isovolumetric relaxation", definition: "Ventricles relax with all valves closed; semilunar valves shut as ventricular pressure drops below arterial pressure.", why_it_matters: "Creates S2 and the dicrotic notch on the aortic pressure curve.", source_ref: "Slide 6", visual_hint: "Aortic pressure curve with a small notch labeled 'dicrotic notch' as aortic valve snaps shut.", mnemonic: "The aorta bounces back and hiccups — that hiccup is the dicrotic notch." },
      { id: "c7", name: "Heart sounds S1 and S2", definition: "S1 'lub' is AV valves closing at the start of systole; S2 'dub' is semilunar valves closing at the start of diastole.", why_it_matters: "Auscultation of heart sounds is a core nursing assessment.", source_ref: "Slides 4, 6", visual_hint: "Timeline: 'lub' over closing AV valves, 'dub' over closing semilunar valves.", mnemonic: "LUB = Leaflets of AV Up (shut); DUB = Doors of the Big arteries shut." },
      { id: "c8", name: "EDV, ESV and stroke volume", definition: "EDV is volume at end of filling (~120 mL), ESV is volume left after ejection (~50 mL); SV = EDV − ESV (~70 mL).", why_it_matters: "SV is a key determinant of cardiac output and perfusion.", source_ref: "Slides 3, 5", visual_hint: "Two measuring cups: 120 mL full, 50 mL left, arrow showing 70 mL poured out.", mnemonic: "Fill 120, leave 50, pour 70 — 'one-twenty minus fifty, stroke is nifty'." },
      { id: "c9", name: "ECG correlation", definition: "P wave triggers atrial contraction, QRS triggers ventricular systole, T wave marks ventricular repolarization and relaxation.", why_it_matters: "Links electrical activity on a monitor to mechanical events of the heart.", source_ref: "Slide 7", visual_hint: "ECG trace with P, QRS, T labeled above a timeline of atria contract → ventricles contract → ventricles relax.", mnemonic: "P = Push atria, QRS = Quick, Really Strong ventricles, T = Time to relax." },
      { id: "c10", name: "Cardiac output & Frank–Starling", definition: "CO = HR × SV (~5 L/min). More stretch from greater EDV produces a stronger contraction and larger SV.", why_it_matters: "Explains how the heart matches output to venous return; basis of fluid and heart-failure management.", source_ref: "Slide 8", visual_hint: "Rubber band stretched further snapping harder; formula CO = HR × SV beside it.", mnemonic: "Stretch the slingshot more, it fires harder — Starling's slingshot." },
      { id: "c11", name: "Murmurs", definition: "Abnormal heart sounds from turbulent flow, caused by stenotic (narrowed) or incompetent (leaky) valves.", why_it_matters: "Murmurs signal valve disease that may need follow-up.", source_ref: "Slide 9", visual_hint: "Smooth flow through a normal valve vs. swirling turbulence through a narrowed one and backflow through a leaky one.", mnemonic: "Stenosis = Stiff & Small door; incompetent = door that won't stay shut." }
    ],
    cards: [
      { title: "Pressure runs the show", emoji: "🌊", concept_ids: ["c1", "c2"], points: ["Blood always flows from high to low pressure", "Valves open and close passively — no muscles", "AV valves: tricuspid and mitral", "Semilunar valves: pulmonary and aortic"], analogy: "Valves are like one-way saloon doors that swing only when the crowd pushes.", source_ref: "Slides 1–2" },
      { title: "Filling the ventricles", emoji: "🛁", concept_ids: ["c3", "c8"], points: ["AV valves open, semilunar valves closed", "70–80% of filling happens passively", "Atrial kick adds the last 20–30%", "End-diastolic volume ≈ 120 mL"], analogy: "Like filling a tub from the tap, then dumping in a last bucket.", source_ref: "Slide 3" },
      { title: "Squeeze with the doors shut", emoji: "🤜", concept_ids: ["c4", "c7"], points: ["Ventricles contract, pressure exceeds atria", "AV valves slam shut → S1 'lub'", "All valves closed, volume unchanged", "Pressure climbs fast toward aortic level"], analogy: "Squeezing a capped ketchup bottle before the cap pops.", source_ref: "Slide 4" },
      { title: "Ejection", emoji: "🚀", concept_ids: ["c5", "c8"], points: ["Ventricular pressure > arterial (~80 mmHg) opens semilunar valves", "Blood ejected into aorta and pulmonary trunk", "SV = EDV − ESV ≈ 70 mL", "ESV ≈ 50 mL stays behind"], analogy: "Pressure beats the bouncer at the aorta's door.", source_ref: "Slide 5" },
      { title: "Relax with the doors shut", emoji: "😮‍💨", concept_ids: ["c6", "c7"], points: ["Ventricles relax, pressure drops below arteries", "Semilunar valves close → S2 'dub'", "Backflow makes the dicrotic notch", "All valves closed again until AV valves reopen"], analogy: "A door snapping shut as the crowd reverses.", source_ref: "Slide 6" },
      { title: "Electrical meets mechanical", emoji: "⚡", concept_ids: ["c9", "c10"], points: ["P wave → atria contract", "QRS → ventricular systole begins", "T wave → ventricles relax", "CO = HR × SV ≈ 5 L/min; more stretch → stronger beat"], analogy: "The ECG is the conductor; the chambers are the orchestra.", source_ref: "Slides 7–8" }
    ],
    concept_map: {
      nodes: [
        { id: "n1", label: "Cardiac cycle", group: "Overview" },
        { id: "n2", label: "Diastole", group: "Overview" },
        { id: "n3", label: "Systole", group: "Overview" },
        { id: "n4", label: "Ventricular filling", group: "Phases" },
        { id: "n5", label: "Isovolumetric contraction", group: "Phases" },
        { id: "n6", label: "Ventricular ejection", group: "Phases" },
        { id: "n7", label: "Isovolumetric relaxation", group: "Phases" },
        { id: "n8", label: "AV valves close", group: "Valves & sounds" },
        { id: "n9", label: "S1 lub", group: "Valves & sounds" },
        { id: "n10", label: "Semilunar valves close", group: "Valves & sounds" },
        { id: "n11", label: "S2 dub", group: "Valves & sounds" },
        { id: "n12", label: "Stroke volume", group: "Output" },
        { id: "n13", label: "Cardiac output", group: "Output" },
        { id: "n14", label: "Frank-Starling law", group: "Output" }
      ],
      edges: [
        { from: "n1", to: "n2", label: "includes" },
        { from: "n1", to: "n3", label: "includes" },
        { from: "n2", to: "n4", label: "contains" },
        { from: "n4", to: "n5", label: "leads to" },
        { from: "n5", to: "n6", label: "leads to" },
        { from: "n6", to: "n7", label: "leads to" },
        { from: "n7", to: "n4", label: "restarts" },
        { from: "n3", to: "n5", label: "begins with" },
        { from: "n5", to: "n8", label: "starts when" },
        { from: "n8", to: "n9", label: "produces" },
        { from: "n7", to: "n10", label: "starts when" },
        { from: "n10", to: "n11", label: "produces" },
        { from: "n6", to: "n12", label: "determines" },
        { from: "n12", to: "n13", label: "multiplied by HR =" },
        { from: "n14", to: "n12", label: "increases" }
      ]
    },
    pretest: [
      { question: "What makes heart valves open and close?", answer: "Pressure differences on either side of the valve — they move passively.", concept_id: "c2" },
      { question: "Which valves closing makes the first heart sound (S1)?", answer: "The AV valves (tricuspid and mitral).", concept_id: "c7" },
      { question: "During isovolumetric contraction, what happens to ventricular volume and pressure?", answer: "Volume stays the same while pressure rises sharply, because all valves are closed.", concept_id: "c4" },
      { question: "How is stroke volume calculated?", answer: "SV = EDV − ESV (about 120 − 50 = 70 mL).", concept_id: "c8" },
      { question: "Which ECG wave starts ventricular systole?", answer: "The QRS complex (ventricular depolarization).", concept_id: "c9" },
      { question: "What does the Frank–Starling law say?", answer: "More stretch from greater end-diastolic volume produces a stronger contraction and larger stroke volume.", concept_id: "c10" }
    ],
    recall: [
      { question: "Define systole and diastole.", answer: "Systole = contraction/ejection phase; diastole = relaxation/filling phase.", concept_id: "c1", kind: "define" },
      { question: "Why do heart valves open and close without any muscle pulling on them?", answer: "They respond passively to pressure gradients — higher pressure behind a valve pushes it open; reversed pressure pushes it shut.", concept_id: "c2", kind: "explain" },
      { question: "Name the two AV valves and the two semilunar valves.", answer: "AV: tricuspid and mitral (bicuspid). Semilunar: pulmonary and aortic.", concept_id: "c2", kind: "define" },
      { question: "What fraction of ventricular filling is passive, and what supplies the rest?", answer: "About 70–80% is passive; atrial systole (the atrial kick) supplies the last 20–30%.", concept_id: "c3", kind: "explain" },
      { question: "A patient develops atrial fibrillation and the atria quiver instead of contracting. How does this affect ventricular filling?", answer: "They lose the atrial kick, so ventricles fill ~20–30% less, lowering EDV, stroke volume and cardiac output.", concept_id: "c3", kind: "apply" },
      { question: "Why is the phase after AV valve closure called 'isovolumetric'?", answer: "All four valves are closed, so blood volume in the ventricles can't change while pressure rises.", concept_id: "c4", kind: "explain" },
      { question: "What must happen for the aortic valve to open?", answer: "Left ventricular pressure must rise above aortic pressure (~80 mmHg).", concept_id: "c5", kind: "explain" },
      { question: "Put in order: ejection, ventricular filling, isovolumetric relaxation, isovolumetric contraction.", answer: "Ventricular filling → isovolumetric contraction → ejection → isovolumetric relaxation.", concept_id: "c5", kind: "sequence" },
      { question: "What causes the dicrotic notch?", answer: "Blood briefly flows back against the closing aortic valve as ventricles relax, creating a small pressure bump on the aortic curve.", concept_id: "c6", kind: "explain" },
      { question: "Compare S1 and S2: which valves close and when?", answer: "S1 = AV valves close at the start of ventricular systole; S2 = semilunar valves close at the start of diastole.", concept_id: "c7", kind: "compare" },
      { question: "Typical EDV is 120 mL and ESV is 50 mL. What is the stroke volume?", answer: "70 mL (SV = EDV − ESV).", concept_id: "c8", kind: "apply" },
      { question: "Define end-systolic volume.", answer: "The blood left in a ventricle after it contracts (~50 mL).", concept_id: "c8", kind: "define" },
      { question: "Match each ECG wave to the mechanical event it triggers.", answer: "P → atrial contraction; QRS → ventricular contraction; T → ventricular relaxation (repolarization).", concept_id: "c9", kind: "compare" },
      { question: "Calculate cardiac output for HR 75 bpm and SV 70 mL.", answer: "≈ 5.25 L/min (75 × 70 mL).", concept_id: "c10", kind: "apply" },
      { question: "Explain the Frank–Starling law in your own words.", answer: "The more the ventricle is stretched by filling (preload/EDV), the more forcefully it contracts, so stroke volume rises.", concept_id: "c10", kind: "explain" },
      { question: "During heavy IV fluid infusion, venous return rises. How does the heart adjust stroke volume, and by what principle?", answer: "Greater EDV stretches fibers → stronger contraction → higher SV, via the Frank–Starling law.", concept_id: "c10", kind: "apply" },
      { question: "Compare a stenotic valve with an incompetent valve.", answer: "Stenotic = narrowed, obstructs forward flow; incompetent = leaky, lets blood flow backward (regurgitation). Both cause murmurs.", concept_id: "c11", kind: "compare" },
      { question: "With mitral valve prolapse, where does blood leak and when?", answer: "Back into the left atrium during ventricular systole (mitral regurgitation).", concept_id: "c11", kind: "apply" }
    ],
    feynman_prompts: [
      { concept_id: "c2", prompt: "Explain to a 12-year-old why heart valves open and close on their own." },
      { concept_id: "c4", prompt: "Explain isovolumetric contraction to a classmate who keeps confusing it with ejection." },
      { concept_id: "c7", prompt: "A patient asks what the 'lub-dub' sound is. Explain it simply." },
      { concept_id: "c8", prompt: "Explain EDV, ESV and stroke volume using a cup of water analogy." },
      { concept_id: "c10", prompt: "Explain to a patient with heart failure what the Frank–Starling law means for their heart." },
      { concept_id: "c9", prompt: "Walk a classmate through how the ECG lines up with what the heart chambers are doing." }
    ]
  }
};
